// popup.js — orchestrates UI + talks to bg
// This version includes:
// - chain-aware slippage auto logic (Solana gets high default, BNB gets 0 default)
// - buildBuyMessage() with per-chain defaults
// - full buy / dry run / signer health / sniper / debug / orders logic
// - UXento integration hooks
//
// Notes:
// - Assumes popup.html defines all the elements referenced by #id
// - Assumes bg.js implements message types: get_settings, set_settings, manual_buy, etc.
// - Assumes content script on uxento.io responds to get_latest_toasts / get_snapshot_now

//----------------------------------------------
// Basic DOM helpers + logging
//----------------------------------------------

const $ = (sel) => document.querySelector(sel);

function appendLog(el, msg) {
  if (!el) return;
  const now = new Date().toISOString();
  let line;

  if (typeof msg === "string") {
    line = msg;
  } else {
    try {
      line = JSON.stringify(msg, null, 2);
    } catch {
      line = String(msg);
    }
  }

  el.textContent += `[${now}] ${line}\n`;
  el.scrollTop = el.scrollHeight;
}

function logBuy(msg) {
  appendLog($('#logBuy'), msg);
}

function logDebug(msg) {
  appendLog($('#logDebug'), msg);
}

function setEnabled(el, yes) {
  if (!el) return;
  el.disabled = !yes;
  el.classList.toggle('is-disabled', !yes);
}

//----------------------------------------------
// Small utils
//----------------------------------------------

// Strip author header lines so the content body is cleaner in logs
function stripHeaderFromPreview(preview, name, handle) {
  try {
    const p = String(preview || '');
    const n = String(name || '').trim();
    const h = String(handle || '').trim();

    // If preview starts with
    // "Sam Altman\n@sama\n4.1M followers\n1m ago\n\nACTUAL BODY..."
    // we want to drop the heading part.
    const lines = p.split('\n').map(x => x.trimEnd());
    if (lines.length < 2) return p;

    // Heuristic: if first 2 lines match name/handle, drop them
    if (
      (n && lines[0].includes(n)) &&
      (h && lines[1] && lines[1].includes(h))
    ) {
      // find first blank line after header and slice there
      let startAt = 2;
      for (let i = 2; i < lines.length; i++) {
        if (lines[i].trim() === '') { startAt = i + 1; break; }
      }
      return lines.slice(startAt).join('\n').trim();
    }

    return p;
  } catch {
    return String(preview || '');
  }
}

// Toast popup inside the popup UI
function showPopupMessage(msg, duration = 2000) {
  let toast = document.getElementById('toast');
  if (!toast) {
    toast = document.createElement('div');
    toast.id = 'toast';
    toast.style.cssText = `
      position: fixed; bottom: 20px; left: 50%; transform: translateX(-50%);
      background: #00eaff; color: #000; padding: 8px 14px; border-radius: 8px;
      font-weight: bold; z-index: 9999; transition: opacity .3s;
      box-shadow: 0 10px 25px rgba(0,0,0,0.5);
      font-size: 12px;
    `;
    document.body.appendChild(toast);
  }

  toast.textContent = msg;
  toast.style.opacity = '1';

  setTimeout(() => {
    if (toast) toast.style.opacity = '0';
  }, duration);
}

//----------------------------------------------
// Uxento tab helpers
//----------------------------------------------

async function findUxentoTab() {
  // look for any uxento.io tab
  const tabs = await chrome.tabs.query({ url: "*://*.uxento.io/*" });
  if (!tabs || tabs.length === 0) return null;
  // prefer active tab in currentWindow, else first
  const preferred = tabs.find(t => t.active && t.currentWindow) || tabs[0];
  return preferred;
}

// Ask the uxento content script for the most recent toaster items
async function requestLatestToastsFromUxento(limit = 10) {
  const tab = await findUxentoTab();
  if (!tab) {
    showPopupMessage("No uxento tab found — open uxento.io in a tab and try again.");
    return null;
  }
  try {
    // Preferred path: ask the content script directly
    const res = await chrome.tabs.sendMessage(tab.id, { type: 'get_latest_toasts', limit });
    if (!res) throw new Error('no response from content script');
    return res;
  } catch (e) {
    // Fallback: executeScript to scrape visible card if message passing failed
    try {
      const [execRes] = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: () => {
          const selector = 'div[data-card="true"], article.relative.font-geist.rounded-md.border.overflow-hidden';
          const root = document.querySelector(selector) || document.body;
          return {
            html: (root && root.outerHTML) || '',
            text: (root && root.innerText) || ''
          };
        }
      });
      return { ok: true, fallback: true, snapshot: execRes?.result };
    } catch (ex) {
      return { ok: false, error: String(ex) };
    }
  }
}

// Ask uxento content script for the "current snapshot" (parsed tweet)
async function requestSnapshotNowFromUxento() {
  const tab = await findUxentoTab();
  if (!tab) return { ok: false, error: 'No uxento tab found' };
  try {
    const res = await chrome.tabs.sendMessage(tab.id, { type: 'get_snapshot_now' });
    return res || { ok: false, error: 'No response' };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

// Get last toast that matches a given tweet payload
async function getToasterHitFor(tweet) {
  const res = await requestLatestToastsFromUxento(20);
  if (!res) return null;

  // legacy path: res.items
  if (Array.isArray(res.items) && res.items.length > 0) {
    const want = tweet?.statusUrl;
    if (!want) return null;
    return res.items.find(it => it.statusUrl && it.statusUrl === want) || null;
  }

  // fallback path: res.toasts (older shape from content script)
  if (Array.isArray(res.toasts)) {
    const want = tweet?.statusUrl;
    if (!want) return null;
    for (const t of res.toasts) {
      const statusUrl = t?.snapshot?.statusUrl;
      if (statusUrl && statusUrl === want) {
        // synthesize a hit shape
        return {
          type: t.type,
          name: t.snapshot?.name,
          handle: t.snapshot?.handle,
          preview: t.snapshot?.text || '',
          statusUrl: t.snapshot?.statusUrl,
          contextUrl:
            (t.snapshot?.links || [])
              .find(u => u && u !== t.snapshot?.statusUrl) || ''
        };
      }
    }
  }

  return null;
}

//----------------------------------------------
// Tab switching (Buy / Sniper / Orders / Debug / Settings etc.)
//----------------------------------------------

document.querySelectorAll('.tab').forEach(btn => {
  btn.addEventListener('click', () => {
    // deactivate everything
    document.querySelectorAll('.tab').forEach(b => b.classList.remove('active'));
    document.querySelectorAll('.panel').forEach(p => p.classList.remove('active'));

    // activate chosen tab + matching panel
    btn.classList.add('active');
    const panel = document.getElementById(`panel-${btn.dataset.tab}`);
    if (panel) panel.classList.add('active');

    // If we just opened Debug tab, pull fresh info
    if (btn.dataset.tab === 'debug') {
      setTimeout(() => {
        if (typeof refreshDebug === 'function') refreshDebug();
      }, 100);
    }

    // If we just opened Orders tab, render them
    if (btn.dataset.tab === 'orders') {
      renderOrders();
    }
  });
});

//----------------------------------------------
// Environment badge + auto-disable sniper UI if uxento isn't open
//----------------------------------------------

async function ensureUxentoPresenceOverride() {
  try {
    const tabs = await chrome.tabs.query({ url: "*://*.uxento.io/*" });
    const hasUxento = Array.isArray(tabs) && tabs.length > 0;

    // Show "uxento: ON/OFF"
    const badge = document.getElementById('envBadge');
    if (badge) {
      badge.textContent = hasUxento ? 'Uxento: ON' : 'Uxento: OFF';
    }

    // Disable any elements that require live uxento capture
    document.querySelectorAll('[data-requires-uxento]').forEach(el => {
      try {
        const disabled = !hasUxento;
        el.classList.toggle('is-disabled', disabled);
        if ('disabled' in el) el.disabled = disabled;
      } catch {}
    });
  } catch {
    // ignore
  }
}

// keep it updated in the popup
ensureUxentoPresenceOverride();
setInterval(ensureUxentoPresenceOverride, 1500);

//----------------------------------------------
// BUY PANEL + signer path (BNB & Solana)
//----------------------------------------------

// DOM refs
const IN_ROUTER    = $('#in-router');
const IN_CA        = $('#in-ca') || $('#in-token'); // contract address / mint
const IN_AMT       = $('#in-amt');                  // buy amount
const IN_GAS       = $('#in-gas');                  // gas gwei (BNB) OR priority fee (SOL)
const IN_CHAIN     = $('#in-chain');                // 'bnb' | 'sol'

const IN_DRYRUN    = $('#in-dryrun');               // checkbox
const IN_GASLIMIT  = $('#in-gaslimit');             // optional override for BNB
const IN_SLIPPAGE  = $('#in-slippage');             // % slippage
const IN_DEADLINE  = $('#in-deadline');             // seconds deadline for BNB swaps

const BTN_BUY         = $('#btnBuy');
const BTN_DRYRUN      = $('#btnDryRun');
const BTN_SIGNER      = $('#btnCheckSigner');
const BTN_CLEAR       = $('#btnClear');
const BTN_FETCH_UXENTO = $('#btnFetchUxento'); // debug fetch button

// SETTINGS PANEL refs
const SET_SIGNER         = $('#set-signer');
const SET_TOKEN          = $('#set-token');
const SET_GAS            = $('#set-gas');
const BTN_SAVE_SETTINGS  = $('#btnSaveSettings');
const SET_TOKEN_2 = document.getElementById('set-token-2'); // Signer #2 API token
const SN_MULTIBUY = document.getElementById('sn-multibuy'); // Multi-buy checkbox in sniper form


//----------------------------------------------
// Slippage auto-default logic (chain-aware)
//----------------------------------------------
//
// Goal:
// - When switching chain to SOL, if slippage box is "" or "0", set to "50" (aggressive default).
// - When switching chain to BNB, if slippage box is "" OR (value >0 AND it was auto-set),
//   then set it to "0".
// - If user manually types in slippage, we stop auto-overwriting it.
//
// We track this using a data attribute on the slippage input.

if (IN_SLIPPAGE) {
  // assume auto-managed at first
  IN_SLIPPAGE.dataset.auto = "true";

  // once user types, mark manual
  IN_SLIPPAGE.addEventListener('input', () => {
    IN_SLIPPAGE.dataset.auto = "false";
  });
}

if (IN_CHAIN && IN_SLIPPAGE) {
  IN_CHAIN.addEventListener('change', () => {
    const chainNow = IN_CHAIN.value.trim().toLowerCase();
    const raw = IN_SLIPPAGE.value.trim();
    const hasVal = raw !== "";
    const numVal = hasVal ? Number(raw) : null;
    const wasAuto = IN_SLIPPAGE.dataset.auto === "true";

    if (chainNow === "sol") {
      // Switching to Solana:
      // If currently blank or 0, bump to 50 and mark as auto
      if (!hasVal || numVal === 0) {
        IN_SLIPPAGE.value = "50";
        IN_SLIPPAGE.dataset.auto = "true";
      }
    } else {
      // Switching to BNB:
      // If blank, OR (value >0 AND it was auto-set), reset to 0
      if (!hasVal || ((numVal !== null && numVal > 0) && wasAuto)) {
        IN_SLIPPAGE.value = "0";
        IN_SLIPPAGE.dataset.auto = "true";
      }
    }

    if (typeof reflectBuyState === "function") {
      reflectBuyState();
    }
  });
}

//----------------------------------------------
// Input validation helpers
//----------------------------------------------

function isPos(n) {
  const v = Number(String(n).trim());
  return Number.isFinite(v) && v > 0;
}

// quick heuristic for a Solana mint (base58-ish)
function looksLikeSolMint(s) {
  const v = String(s || '').trim();
  // base58 characters, 32-50 length covers pump mints/public keys
  return /^[1-9A-HJ-NP-Za-km-z]{32,50}$/.test(v);
}

// validate token/CA for selected chain
function isValidTokenForChain(chain, caVal) {
  const v = String(caVal || '').trim();
  if (chain === 'bnb') {
    // normal 20-byte EVM address
    return /^0x[0-9a-fA-F]{40}$/.test(v);
  }
  if (chain === 'sol') {
    // base58 public key or pump mint
    return looksLikeSolMint(v);
  }
  return false;
}

// enable/disable buy buttons according to inputs
function reflectBuyState() {
  const chainVal = IN_CHAIN?.value ? IN_CHAIN.value.trim().toLowerCase() : 'bnb';

  const caOK   = isValidTokenForChain(chainVal, IN_CA?.value);
  const amtOK  = isPos(IN_AMT?.value);
  const gasOK  = isPos(IN_GAS?.value); // require fee/priority fee for both chains

  const canBuy = caOK && amtOK && gasOK;

  if (BTN_BUY) setEnabled(BTN_BUY, canBuy);
  if (BTN_DRYRUN) setEnabled(BTN_DRYRUN, canBuy);
}

// re-check whenever inputs change
['input','change'].forEach(evt => {
  [IN_ROUTER, IN_CA, IN_AMT, IN_GAS, IN_CHAIN].forEach(el => {
    if (!el) return;
    el.addEventListener(evt, reflectBuyState);
  });
});

reflectBuyState();

//----------------------------------------------
// Build the message for bg.js (/signer) based on current form
//----------------------------------------------

function buildBuyMessage(dryRun = false) {
  const chain = (IN_CHAIN && IN_CHAIN.value)
    ? IN_CHAIN.value.trim().toLowerCase()
    : 'bnb';

  const token = (IN_CA?.value || '').trim();

  // amount:
  // - BNB mode: this is BNB amount
  // - SOL mode: this is SOL amount
  const amountNum = Number(IN_AMT?.value);

  // gas:
  // - BNB mode: gas gwei
  // - SOL mode: priority fee
  const gasNum = Number(IN_GAS?.value);

  // advanced toggles
  const wantDryRun = !!(dryRun || (IN_DRYRUN && IN_DRYRUN.checked));

  const gasLimitVal = (IN_GASLIMIT && IN_GASLIMIT.value.trim() !== "")
    ? Number(IN_GASLIMIT.value)
    : undefined;

  // slippage box (plain number, percent)
  let userSlip;
  if (IN_SLIPPAGE && IN_SLIPPAGE.value.trim() !== "") {
    userSlip = Number(IN_SLIPPAGE.value.trim());
  } else {
    userSlip = undefined;
  }

  const deadlineVal = (IN_DEADLINE && IN_DEADLINE.value.trim() !== "")
    ? Number(IN_DEADLINE.value)
    : undefined;

  // chain-based default slippage:
  // - BNB default: 0 (treat as "accept anything / no minOut guard")
  // - SOL default: 50 (%). Using 0 on Solana will trigger ExceededSlippage all the time.
  let finalSlippage;
  if (typeof userSlip === 'number' && !Number.isNaN(userSlip)) {
    finalSlippage = userSlip;
  } else {
    finalSlippage = (chain === 'sol') ? 50 : 0;
  }

  if (chain === 'bnb') {
    // This will route to signer /swap (PancakeSwap style)
    return {
      type: 'manual_buy',
      chain: 'bnb',
      signerChain: 'bnb',
      token,                        // CA / token address
      amountBNB: amountNum,         // how much BNB to spend
      gasGwei: gasNum || undefined, // gas price
      router: IN_ROUTER?.value?.trim() || undefined,
      dryRun: wantDryRun || undefined,
      gasLimit: gasLimitVal,
      slippage: finalSlippage,      // %
      deadline: deadlineVal         // seconds
    };
  } else {
    // chain === 'sol'
    // This will route to signer /swapSol (Jupiter / Pump route)
    return {
      type: 'manual_buy',
      chain: 'sol',
      signerChain: 'sol',
      token,                        // mint address
      amountSOL: amountNum,          // how much SOL to spend
      priorityFee: gasNum || undefined, // lamport tip (priority fee)
      slippage: finalSlippage,      // %
      dryRun: wantDryRun || undefined
      // gasLimit/deadline/router not relevant for Sol here
    };
  }
}

//----------------------------------------------
// BUY button with timing debug
//----------------------------------------------

if (BTN_BUY) {
  BTN_BUY.addEventListener('click', async () => {
    const clickTime = Date.now();
    const clickPerf = performance.now();

    logBuy("========== NEW BUY REQUEST ==========");
    logBuy(`[TIMING] Button clicked at: ${new Date(clickTime).toISOString()}`);
    logBuy(`[TIMING] Click timestamp: ${clickTime}`);
    logBuy(`[TIMING] Performance counter: ${clickPerf.toFixed(2)}ms`);
    logBuy("Submitting to local signer...");

    const t0 = performance.now();
    const msg = buildBuyMessage(false);
    const msgBuilt = performance.now();
    logBuy(`[TIMING] Message built in: ${Math.round(msgBuilt - t0)}ms`);

    const res = await chrome.runtime.sendMessage(msg).catch(e => ({
      ok:false,
      error:e?.message || String(e)
    }));

    const t1 = performance.now();

    logBuy("[TIMING] ====== TIMING BREAKDOWN ======");
    logBuy(`[TIMING] Total UI→BG→Signer→UI: ${Math.round(t1 - t0)}ms`);
    logBuy(`[TIMING] Signer reported: ${res.elapsedMs || 'N/A'}ms`);
    const overhead = (typeof res.elapsedMs === 'number')
      ? Math.round((t1 - t0) - res.elapsedMs)
      : 'N/A';
    logBuy(`[TIMING] Chrome overhead: ${overhead}ms`);
    logBuy("[TIMING] ============================");

    if (res?.ok) {
      if (res.dryRun) {
        // signer accepted but didn't broadcast
        logBuy({
          ok: true,
          dryRun: true,
          message: 'Dry run successful - no transaction sent',
          elapsedMs: res.elapsedMs
        });
      } else {
        // real buy
        logBuy({
          ok: true,
          hash: res.hash,
          sig: res.sig,
          mode: res.mode,
          via: res.via,
          rpcUsed: res.rpcUsed,
          gasPriceGwei: res.gasPriceGwei,
          elapsedMs: res.elapsedMs,
          timing: res.timing
        });
        logBuy(`⏰ CHECK BSCSCAN / SOLSCAN: Compare ${new Date(clickTime).toISOString()} with block timestamp`);
      }
    } else {
      logBuy({ ok:false, error:res?.error || 'Unknown error' });
      if (res?.status || res?.raw) logBuy(res);
    }
  });
}

//----------------------------------------------
// DRY RUN button (no broadcast)
//----------------------------------------------

if (BTN_DRYRUN) {
  BTN_DRYRUN.addEventListener('click', async () => {
    logBuy("Testing transaction (dry run)...");
    const msg = buildBuyMessage(true);

    const res = await chrome.runtime.sendMessage(msg).catch(e => ({
      ok:false,
      error:e?.message || String(e)
    }));

    if (res?.ok) {
      logBuy({
        ok: true,
        dryRun: true,
        message: 'Dry run passed - transaction is valid',
        elapsedMs: res.elapsedMs,
        dataLen: res.dataLen
      });
    } else {
      logBuy({
        ok:false,
        error:res?.error || 'Dry run failed',
        raw: res
      });
    }
  });
}

//----------------------------------------------
// SIGNER HEALTH CHECK button
//----------------------------------------------

if (BTN_SIGNER) {
  BTN_SIGNER.addEventListener('click', async () => {
    try {
      const { settings } = await chrome.runtime.sendMessage({ type:'get_settings' });
      const base = settings?.signerUrl || 'http://127.0.0.1:8787/swap';
      const health = base.replace(/\/swap\/?$/,'/health');

      const r = await fetch(health);
      const j = await r.json();
      logBuy("Signer health:");
      logBuy(j);
    } catch (e) {
      logBuy("Signer health fetch failed: " + (e?.message || e));
    }
  });
}

// CLEAR LOG button
if (BTN_CLEAR) {
  BTN_CLEAR.addEventListener('click', () => {
    const l = $('#logBuy');
    if (l) l.textContent = "";
  });
}

//----------------------------------------------
// SETTINGS panel (signer URL / API token / default gas)
//----------------------------------------------

if (BTN_SAVE_SETTINGS) {
  BTN_SAVE_SETTINGS.addEventListener('click', async () => {
    const patch = {};

    if (SET_SIGNER && SET_SIGNER.value.trim() !== "") {
      patch.signerUrl = SET_SIGNER.value.trim();
    }
    if (SET_TOKEN && SET_TOKEN.value.trim() !== "") {
      patch.apiToken = SET_TOKEN.value.trim();
    }
    if (SET_GAS && SET_GAS.value.trim() !== "") {
      patch.defaultGasGwei = Number(SET_GAS.value.trim());
    }
    // add after patch.apiToken = ...
if (SET_TOKEN_2 && SET_TOKEN_2.value.trim() !== "") {
  patch.apiToken2 = SET_TOKEN_2.value.trim();
}


    await chrome.runtime.sendMessage({ type:'set_settings', patch });
    showPopupMessage('Settings saved!');
  });
}

// Load settings into the panel on open
(async () => {
  try {
    const { settings } = await chrome.runtime.sendMessage({ type:'get_settings' });
    if (SET_SIGNER) SET_SIGNER.value = settings?.signerUrl || 'http://127.0.0.1:8787/swap';
    if (SET_TOKEN)  SET_TOKEN.value  = settings?.apiToken || '';
    if (SET_TOKEN_2) SET_TOKEN_2.value = settings?.apiToken2 || '';

    if (SET_GAS)    SET_GAS.value    = (settings?.defaultGasGwei ?? 3);
  } catch {
    // ignore
  }
})();

//----------------------------------------------
// "Fetch from Uxento" button for debugging
//----------------------------------------------

if (BTN_FETCH_UXENTO) {
  BTN_FETCH_UXENTO.addEventListener('click', async () => {
    const prevLabel = BTN_FETCH_UXENTO.textContent;
    BTN_FETCH_UXENTO.textContent = 'Fetching…';
    BTN_FETCH_UXENTO.disabled = true;
    try {
      const res = await requestLatestToastsFromUxento(15);
      if (!res) {
        logBuy('No response from uxento');
      } else if (Array.isArray(res.toasts)) {
        logBuy(`Fetched latest toasts from toaster (${res.toasts.length}):`);
        for (const t of res.toasts) {
          logBuy(`--- ${t.type} @ ${new Date(t.ts).toLocaleTimeString()}`);
          logBuy(t.snapshot || {});
        }
      } else if (Array.isArray(res.items)) {
        logBuy(`Fetched latest toasts (unified items: ${res.items.length}):`);
        for (const it of res.items) {
          logBuy(it);
        }
      } else {
        logBuy(res);
      }
    } catch (err) {
      logBuy("Uxento fetch failed: " + (err?.message || err));
    } finally {
      BTN_FETCH_UXENTO.textContent = prevLabel;
      BTN_FETCH_UXENTO.disabled = false;
    }
  });
}

//----------------------------------------------
// BACKGROUND → POPUP live events
//----------------------------------------------
//
// bg.js can chrome.runtime.sendMessage({type:'sniper_fired', ...})
// or forward 'tweet_event' etc. We'll listen and pretty-print.
chrome.runtime.onMessage.addListener((msg, sender) => {
  (async () => {
    // SNIPER FIRED NOTIFICATION
    if (msg?.type === 'sniper_fired') {
      logBuy("🚨 SNIPER TRIGGERED 🚨");
      if (msg.gmgnUrl)   logBuy("GMGN URL: " + String(msg.gmgnUrl));
      if (msg.token)     logBuy("Token: " + String(msg.token));

      if (msg.result) {
        const r = msg.result;
        if (r.ok) {
          logBuy("✅ Buy succeeded: " + (r.hash || r.sig || 'sent'));
          if (r.elapsedMs) logBuy(`⏱ Execution time: ${r.elapsedMs}ms`);
        } else {
          logBuy("❌ Buy failed: " + (r.error || 'unknown error'));
          logBuy(r);
        }
      }

      return;
    }

    // TWEET EVENT (live tweet captured by content script, forwarded via bg)
    if (msg?.type === 'tweet_event' && msg.tweet) {
      const hit = await getToasterHitFor(msg.tweet);
      const now = new Date().toLocaleTimeString();

      if (hit) {
        // nice structured hit (from toaster or reconstructed)
        const type = hit.type || 'tweet';
        const name = hit.name || hit.snapshot?.name || '';
        const handle = hit.handle || hit.snapshot?.handle || '';
        const textPreview = hit.preview || hit.snapshot?.text || '';
        const TYPE_LABELS = {
          tweet: 'Tweet',
          retweet: 'Retweet',
          reply: 'Reply',
          quote: 'Quote'
        };

        logBuy(`LIVE ${now}`);
        if (name)   logBuy(name);
        if (handle) logBuy(handle);
        logBuy(`POST TYPE: ${TYPE_LABELS[type] || 'Tweet'}`);

        if (type !== 'retweet' && textPreview) {
          const bodyOnly = stripHeaderFromPreview(textPreview, name, handle);
          logBuy("CONTENT:");
          logBuy(bodyOnly);
        }

        const ctx = hit.contextUrl || '';
        if (ctx) logBuy(`URL: ${ctx}`);

        // mark env
        const envBadge = $('#envBadge');
        if (envBadge) envBadge.textContent = 'Uxento: ON (live)';
      } else {
        // fallback dump if we didn't correlate w/ toaster
        logBuy(`LIVE ${now} (raw tweet event)`);
        logBuy(msg.tweet);
      }
      return;
    }

    // 🔴 NEW: sniper_eval_result -> update Orders tab
    if (msg?.type === 'sniper_eval_result') {
      try {
        const idx = msg.idx;
        const summary = msg.summary || '';

        // 1. Update storage copy of the orders array so it's persistent
        const cur = await getOrders(); // popup.js local helper, writes chrome.storage.local
        if (cur[idx]) {
          cur[idx].lastResult = summary;
          await setOrders(cur);
        }

        // 2. If Orders tab is currently rendered, live-update the row text
        //    without forcing a full re-render flicker.

        const rowSel = `.order-row[data-idx="${idx}"] .last-result`;
        const node = document.querySelector(rowSel);
        if (node) {
          node.textContent = summary;
        } else {
          // If we can't find the row (maybe Orders tab isn't open),
          // we'll just re-render next time user opens Orders tab.
        }
      } catch (e) {
        console.warn('failed to apply sniper_eval_result', e);
      }

      return;
    }

  })();
});

//----------------------------------------------
// DEBUG TAB AUTO-REFRESH
//----------------------------------------------

// Pretty-print items returned from requestLatestToastsFromUxento
function formatToastLine(it) {
  const t = new Date(it.at || it.ts || Date.now()).toLocaleTimeString();
  const who = (it.name || '') + ' ' + (it.handle || '');
  if (it.type === 'retweet') {
    return `[${t}] RETWEET — ${who} → ${it.contextUrl || '(no link)'} | author: ${it.statusUrl || '—'}`;
  } else if (it.type === 'reply') {
    return `[${t}] REPLY   — ${who} ↪ ${it.contextUrl || '(no link)'} | author: ${it.statusUrl || '—'}`;
  } else if (it.type === 'quote') {
    return `[${t}] QUOTE   — ${who} ⤴ ${it.contextUrl || '(no link)'} | author: ${it.statusUrl || '—'}`;
  } else if (it.type === 'tweet') {
    return `[${t}] TWEET   — ${who} | ${it.statusUrl || '—'}`;
  }
  return `[${t}] OTHER    — ${who} | ${it.statusUrl || '—'}`;
}

async function refreshDebug() {
  const res = await requestLatestToastsFromUxento(12);
  if (!res) {
    logDebug('(error) No response from toaster / no uxento tab?');
    return;
  }
  if (res.ok === false) {
    logDebug(`(error) ${res.error || 'No uxento response'}\nOpen uxento.io first.`);
    return;
  }

  let items = [];
  if (Array.isArray(res.items)) {
    items = res.items;
  } else if (Array.isArray(res.toasts)) {
    // legacy shape
    items = res.toasts.map(t => ({
      type: t.type,
      name: t.snapshot?.name,
      handle: t.snapshot?.handle,
      statusUrl: t.snapshot?.statusUrl,
      contextUrl:
        (t.snapshot?.links || [])
          .find(u => u && u !== t.snapshot?.statusUrl) || '',
      at: t.ts,
      preview: t.snapshot?.text || ''
    }));
  }

  if (!items.length) {
    logDebug('(info) No recent toast items');
    return;
  }

  logDebug(`=== DEBUG SNAPSHOT (${items.length} items) ===`);
  for (const it of items) {
    logDebug(formatToastLine(it));
  }
}

// auto-refresh checkbox in Debug tab:
let autoTimer = null;
const AUTOCHK = $('#autoRefreshDebug');
if (AUTOCHK) {
  AUTOCHK.addEventListener('change', () => {
    if (AUTOCHK.checked) {
      refreshDebug();
      autoTimer = setInterval(refreshDebug, 1500);
    } else {
      if (autoTimer) {
        clearInterval(autoTimer);
        autoTimer = null;
      }
    }
  });
}

// If Debug tab is already active at load, refresh once after a short delay
setTimeout(() => {
  const cur = document.querySelector('.tab.active');
  if (cur?.dataset.tab === 'debug') {
    refreshDebug();
  }
}, 300);
//----------------------------------------------
// Sniper tab slippage auto-default logic (chain-aware)
// Mirrors the Buy tab logic but for #sn-chain / #sn-slippage
//----------------------------------------------

const SN_CHAIN     = document.querySelector('#sn-chain');      // 'bnb' | 'sol'
const SN_SLIPPAGE  = document.querySelector('#sn-slippage');   // % slippage input

if (SN_SLIPPAGE) {
  // assume sniper slippage starts auto-managed
  SN_SLIPPAGE.dataset.auto = "true";

  // once the user types in sniper slippage, mark it manual
  SN_SLIPPAGE.addEventListener('input', () => {
    SN_SLIPPAGE.dataset.auto = "false";
  });
}

if (SN_CHAIN && SN_SLIPPAGE) {
  SN_CHAIN.addEventListener('change', () => {
    const chainNow = SN_CHAIN.value.trim().toLowerCase();
    const raw = SN_SLIPPAGE.value.trim();
    const hasVal = raw !== "";
    const numVal = hasVal ? Number(raw) : null;
    const wasAuto = SN_SLIPPAGE.dataset.auto === "true";

    if (chainNow === "sol") {
      // switching sniper order to Solana:
      // if it's blank or 0, bump to 50 and mark as auto
      if (!hasVal || numVal === 0) {
        SN_SLIPPAGE.value = "50";
        SN_SLIPPAGE.dataset.auto = "true";
      }
    } else {
      // switching sniper order to BNB:
      // if it's blank, OR (value >0 AND it was auto-set), force 0
      if (!hasVal || ((numVal !== null && numVal > 0) && wasAuto)) {
        SN_SLIPPAGE.value = "0";
        SN_SLIPPAGE.dataset.auto = "true";
      }
    }
  });
}

//----------------------------------------------
// SNIPER ORDERS UI
//----------------------------------------------
//
// We persist an array of "orders" in chrome.storage.local.
// Each order watches for certain tweet patterns, and when matched,
// bg.js/sniper can auto-buy using signer.
// We support BNB and SOL, and optional advanced params (gasLimit, slippage, deadline).
const SKEY = { ORDERS: 'orders' };

async function getOrders() {
  const v = await chrome.storage.local.get(SKEY.ORDERS);
  return v[SKEY.ORDERS] || [];
}

async function setOrders(arr) {
  await chrome.storage.local.set({ [SKEY.ORDERS]: arr });
  return arr;
}

// Build human-readable row for the Orders tab list
function formatOrderRow(order, idx) {
  const pausedTxt   = order.paused ? ' (PAUSED)' : '';
  const dryRunTxt   = order.dryRun ? ' [DRY RUN]' : '';
  const lastResult  = order.lastResult || 'Never checked';

  // Prefer explicit order name, then tweetType, then Any
  const title = order.orderName || order.name || order.tweetType || 'Any';

  const chain = (order.chain || 'bnb').toLowerCase();
  const amtLabel = (chain === 'sol') ? 'SOL' : 'BNB';
  const gasLabel = (chain === 'sol') ? 'prio' : 'gwei';

  const wordsJoined = Array.isArray(order.contentWords)
    ? order.contentWords.join(', ')
    : '';

  // Optional Raydium CA line
  const raydiumLine = order.raydiumCa
    ? `<div>Raydium CA: ${order.raydiumCa}</div>`
    : '';

  // NEW: Reference URL line
  const refLine = order.referenceUrl
    ? `<div>Ref URL: ${order.referenceUrl}</div>`
    : '';

  // Advanced params summary
  const params = [];
  if (order.gasLimit) params.push(`Gas limit: ${order.gasLimit}`);
  if (order.slippage !== undefined && order.slippage !== null && order.slippage !== "") {
    params.push(`Slippage: ${order.slippage}%`);
  }
  if (order.deadline) params.push(`Deadline: ${order.deadline}s`);

  // Always show Multi-buy: Yes/No
  const multi = order.multiBuy ? 'Yes' : 'No';
  params.push(`Multi-buy: ${multi}`);
  const special = order.specialBuy ? 'Yes' : 'No';
params.push(`Special: ${special}`);
const night = order.nightMode ? 'Yes' : 'No';
params.push(`Night Mode: ${night}`);

  // BNB Route Mode (only for BNB orders)
  if (chain === 'bnb') {
    let modeLabel = 'graduated';
    if (order.mode === 'four') modeLabel = 'four.meme';
    else if (order.mode === 'binance-exclusive') modeLabel = 'binance-exclusive';
    else if (order.mode === 'auto') modeLabel = 'auto';
    params.push(`BNB Route: ${modeLabel}`);
  }

  const paramStr = params.length
    ? `<div style="font-size:11px;opacity:0.7;">${params.join(' | ')}</div>`
    : '';

  return `
    <div class="order-row" data-idx="${idx}">
      <div><strong>${title}</strong>${pausedTxt}${dryRunTxt}</div>
      <div>${order.author || ''} | ${wordsJoined}</div>
      <div>CA/Mint: ${order.ca || ''}</div>
      ${raydiumLine}
      ${refLine}
      <div>Buy: ${order.amount || '0'} ${amtLabel} @ ${order.gas || '3'} ${gasLabel} [${chain.toUpperCase()}]</div>
      ${paramStr}
      <div style="margin-top:4px;font-size:12px;">Last: <span class="last-result">${lastResult}</span></div>
      <div style="margin-top:6px;">
        <button class="order-pause btn"> ${order.paused ? 'Resume' : 'Pause'} </button>
        <button class="order-nightmode btn" title="Toggle night mode for this order">
          🌙 ${order.nightMode ? 'ON' : 'OFF'}
        </button>
        <button class="order-edit btn">Edit</button>
        <button class="order-remove btn">Remove</button>
      </div>
    </div>
  `;
}




// Render all orders into the Orders tab
async function renderOrders() {
  const list = document.getElementById('ordersList');
  if (!list) return;

  const arr = await getOrders();
  if (!arr.length) {
    list.innerHTML =
      '<div style="text-align:center;padding:20px;font-size:12px;opacity:0.7;">' +
      'No orders yet. Create one in the Sniper tab!' +
      '</div>';
    return;
  }

  list.innerHTML = arr
    .map((o,i) => formatOrderRow(o,i))
    .join('<hr style="border:1px solid #1c2a35;margin:8px 0;"/>');

  // Pause/Resume
  document.querySelectorAll('.order-pause').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      const row = e.target.closest('.order-row');
      if (!row) return;
      const idx = Number(row.dataset.idx || 0);

      const cur = await getOrders();
      const ord = cur[idx];
      if (!ord) return;

      ord.paused = !ord.paused;
      if (!ord.lastResult) ord.lastResult = 'Never checked';
      await setOrders(cur);
      renderOrders();
    });
  });

  // Night Mode Toggle (individual order)
  document.querySelectorAll('.order-nightmode').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      const row = e.target.closest('.order-row');
      if (!row) return;
      const idx = Number(row.dataset.idx || 0);

      const cur = await getOrders();
      const ord = cur[idx];
      if (!ord) return;

      ord.nightMode = !ord.nightMode;
      // If enabling night mode and sellAfterSeconds is not set, use default
      if (ord.nightMode && !ord.sellAfterSeconds) {
        ord.sellAfterSeconds = 2;
      }
      await setOrders(cur);
      showPopupMessage(`Night mode ${ord.nightMode ? 'enabled' : 'disabled'} for order`);
      renderOrders();
    });
  });

  // Remove
  document.querySelectorAll('.order-remove').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      if (!confirm('Remove this order?')) return;
      const row = e.target.closest('.order-row');
      if (!row) return;
      const idx = Number(row.dataset.idx || 0);

      const cur = await getOrders();
      cur.splice(idx, 1);
      await setOrders(cur);
      renderOrders();
    });
  });

  // Edit
 document.querySelectorAll('.order-edit').forEach(btn => {
  btn.addEventListener('click', async (e) => {
    const row = e.target.closest('.order-row');
    if (!row) return;
    const idx = Number(row.dataset.idx || 0);

    const arr = await getOrders();
    const order = arr[idx] || {};

    // === existing logic preserved ===
    const snName      = $('#sn-name');
    const snType      = $('#sn-type');
    const snAuthor    = $('#sn-author');
    const snContent   = $('#sn-content');
    const snRef       = $('#sn-ref');
    const snChain     = $('#sn-chain');
    const snAmount    = $('#sn-amount');
    const snGas       = $('#sn-gas');
    const snCa        = $('#sn-ca');
    const snRouter    = $('#sn-router');
    const snMode      = $('#sn-mode'); 
    
    const snDryRun    = $('#sn-dryrun');
    const snGasLimit  = $('#sn-gaslimit');
    const snSlippage  = $('#sn-slippage');
    const snDeadline  = $('#sn-deadline');
    const snRaydium   = $('#sn-raydiumca');
    const snSpecial   = $('#sn-special');

    if (snType && order.tweetType) {
  snType.value = order.tweetType;
}
if (snName)      snName.value   = order.orderName || order.name || '';
if (snType && order.tweetType) {
  snType.value = order.tweetType;
}


    if (snAuthor)    snAuthor.value  = order.author || '';
    if (snContent)   snContent.value = (order.contentWords || []).join(', ');
    if (snRef)       snRef.value     = order.referenceUrl || '';
    if (snChain)     snChain.value   = order.chain || 'bnb';
    if (snAmount)    snAmount.value  = order.amount || '';
    if (snGas)       snGas.value     = order.gas || '';
    if (snMode)      snMode.value    = order.mode || 'pancake';
    if (snCa)        snCa.value      = order.ca || '';
    if (snRouter)    snRouter.value  = order.router || '';
    if (snDryRun)    snDryRun.checked = !!order.dryRun;
    if (snGasLimit)  snGasLimit.value = order.gasLimit || '';
    if (snSlippage)  snSlippage.value = order.slippage || '';
    if (snDeadline)  snDeadline.value = order.deadline || '';
    // NEW line — preserve blank default if undefined
    if (snRaydium)   snRaydium.value = order.raydiumCa || '';
    if (SN_MULTIBUY) SN_MULTIBUY.checked = !!order.multiBuy;
    const snNightModeEl = document.getElementById('sn-nightmode');
if (snNightModeEl) snNightModeEl.checked = !!order.nightMode;

    // Populate night mode timing field - SIMPLIFIED
    const sellAfterEl = document.getElementById('sn-nm-sellafter');
    const nmTimingDiv = document.getElementById('nightmode-timing');
    
    if (order.nightMode && order.sellAfterSeconds != null) {
      if (sellAfterEl) sellAfterEl.value = order.sellAfterSeconds;
      if (nmTimingDiv) nmTimingDiv.style.display = 'block';
    } else {
      // Reset to default if not set
      if (sellAfterEl) sellAfterEl.value = 2;
      if (nmTimingDiv) nmTimingDiv.style.display = order.nightMode ? 'block' : 'none';
    }
    
    if (snSpecial)   snSpecial.checked = !!order.specialBuy;

    // === everything else unchanged ===
    const logicVal = order.logicType || 'or';
    const logicRadio = document.querySelector(`input[name="sn-logic"][value="${logicVal}"]`);
    if (logicRadio) logicRadio.checked = true;

    document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
    const sniperTab = document.querySelector('.tab[data-tab="sniper"]');
    if (sniperTab) sniperTab.classList.add('active');

    document.querySelectorAll('.panel').forEach(p => p.classList.remove('active'));
    const panel = document.getElementById('panel-sniper');
    if (panel) panel.classList.add('active');

    window.__editingOrderIdx = idx;

    const addBtn = $('#sn-add');
    if (addBtn) addBtn.textContent = 'Update Order';
  });
});

}
// ---- Popout button handler ----
const BTN_POPOUT = document.getElementById('btnPopout');
if (BTN_POPOUT) {
  BTN_POPOUT.addEventListener('click', async () => {
    try {
      await chrome.windows.create({
        url: chrome.runtime.getURL('popup_window.html'),
        type: 'popup',
        width: 480,
        height: 820
      });
    } catch (e) {
      window.open(
        chrome.runtime.getURL('popup_window.html'),
        '_blank',
        'noopener'
      );
    }
  });
}

// ---- Global Night Mode Toggle ----
const BTN_TOGGLE_NIGHT = document.getElementById('btnToggleNightMode');
if (BTN_TOGGLE_NIGHT) {
  BTN_TOGGLE_NIGHT.addEventListener('click', async () => {
    const arr = await getOrders();
    if (!arr || arr.length === 0) {
      showPopupMessage('No orders to toggle');
      return;
    }

    // Check if any orders have night mode disabled
    const anyDisabled = arr.some(order => !order.nightMode);
    
    // If any are disabled, enable all. Otherwise, disable all.
    const newState = anyDisabled;
    
    arr.forEach(order => {
      order.nightMode = newState;
    });

    await setOrders(arr);
    renderOrders();
    
    const action = newState ? 'enabled' : 'disabled';
    showPopupMessage(`Night mode ${action} for all orders`);
  });
}

//----------------------------------------------
// Sniper order create / update
//----------------------------------------------
window.addEventListener('load', async () => {
  const addBtn = document.getElementById('sn-add');
  if (!addBtn) {
    // no sniper section in this popup build
    return;
  }

  addBtn.addEventListener('click', async () => {
    // Gather user input from Sniper tab
    const orderName = (document.getElementById('sn-name')?.value || '').trim();  // NEW
    const tweetType = document.getElementById('sn-type')?.value || '';
    const author    = (document.getElementById('sn-author')?.value || '').trim();
    const content   = (document.getElementById('sn-content')?.value || '').trim();
    const contentWords = content
      ? content.split(',').map(s => s.trim()).filter(Boolean)
      : [];
    const logic     = document.querySelector('input[name="sn-logic"]:checked')?.value || 'or';
    const ref       = (document.getElementById('sn-ref')?.value || '').trim();

    // buy config (chain-aware)
    const chain     = (document.getElementById('sn-chain')?.value || 'bnb')
                        .trim()
                        .toLowerCase();
    const amount    = (document.getElementById('sn-amount')?.value || '').trim();
    const gas       = (document.getElementById('sn-gas')?.value || '').trim();       // BNB gas gwei OR SOL priority fee
    const ca        = (document.getElementById('sn-ca')?.value || '').trim();        // CA (bnb) or mint (sol)
    const router    = (document.getElementById('sn-router')?.value || '').trim();
    const raydiumCa = (document.getElementById('sn-raydiumca')?.value || '').trim();
    const specialBuy = !!document.getElementById('sn-special')?.checked;


    // advanced params (raw form values)
    const dryRun    = !!document.getElementById('sn-dryrun')?.checked;
    const gasLimitV = (document.getElementById('sn-gaslimit')?.value || '').trim();
    const slipRaw   = (document.getElementById('sn-slippage')?.value || '').trim();
    const deadlineV = (document.getElementById('sn-deadline')?.value || '').trim();
    const multiBuy  = !!(SN_MULTIBUY && SN_MULTIBUY.checked);
    const nightMode = !!document.getElementById('sn-nightmode')?.checked;
    
    // Night mode timing configuration - SIMPLIFIED to single value
    const sellAfterSeconds = Number(document.getElementById('sn-nm-sellafter')?.value || 2);
        // BNB-only route mode selector (Solana ignores this)
    let mode = 'pancake'; // default: graduated / Pancake
    if (chain === 'bnb') {
      const modeEl = document.getElementById('sn-mode');
      if (modeEl && modeEl.value) {
        const m = modeEl.value.trim().toLowerCase();
        if (m === 'four' || m === 'auto' || m === 'pancake' || m === 'binance-exclusive') {
          mode = m;
        }
      }
    }
// If special buy is enabled on BNB, we don't require CA/amount here
const isSpecial = specialBuy && chain === 'bnb';

if (!isSpecial) {
  if (!ca || !amount) {
    showPopupMessage('Please provide Contract Address / Mint and Amount');
    return;
  }
}


    // ---- chain-aware slippage defaulting ----
    // User can type whatever slippage they want. If they leave it blank or 0,
    // we force:
    //   - Solana: 50
    //   - BNB:    0
    let slipNum = slipRaw === '' ? null : Number(slipRaw);
    let finalSlip;
    if (!Number.isFinite(slipNum) || slipNum === null || slipNum === 0) {
      finalSlip = (chain === 'sol') ? 50 : 0;
    } else {
      finalSlip = slipNum;
    }

    // Build the order object we store.
    // We intentionally keep generic field names:
    //  - chain: 'bnb' | 'sol'
    //  - amount: string (BNB amount or SOL amount)
    //  - gas: string (BNB gas gwei or SOL priority fee)
    //  - ca: CA (bnb) or mint (sol)
    //
    // bg.js will later translate:
    //   if chain === 'bnb':
    //       amount -> amountBNB
    //       gas    -> gasGwei
    //   if chain === 'sol':
    //       amount -> amountSOL
    //       gas    -> priorityFee
    // and will pass slippage along.
const orderData = {
  orderName,
  tweetType,
  author,
  contentWords,
  logicType: logic,
  referenceUrl: ref,

  chain,
  amount,
  gas,
  ca,
  router,
  raydiumCa,
  dryRun,
  specialBuy,

  paused: false,
  lastResult: null,

  slippage: finalSlip,
  multiBuy,
  nightMode,
  // Night mode timing - SIMPLIFIED: just the delay in seconds
  sellAfterSeconds: nightMode ? sellAfterSeconds : null
};
        // BNB-only: store route mode (Pancake / Four.meme / Auto)
    if (chain === 'bnb') {
      orderData.mode = mode;
    } 

    // attach advanced numeric params if present
    if (gasLimitV)  orderData.gasLimit  = Number(gasLimitV);
    if (deadlineV)  orderData.deadline  = Number(deadlineV);

    // load existing orders
    const arr = await getOrders();

    // if we're editing an existing order, replace it
    if (typeof window.__editingOrderIdx === 'number') {
      const idx = window.__editingOrderIdx;
      arr[idx] = orderData;
      delete window.__editingOrderIdx;
      const updateBtn = $('#sn-add');
      if (updateBtn) updateBtn.textContent = 'Add Order';
    } else {
      // otherwise append new
      arr.push(orderData);
    }

    await setOrders(arr);
    showPopupMessage('Order saved');

    // clear sniper form after save
    const snNameEl      = document.getElementById('sn-name');   // NEW
    const snTypeEl      = document.getElementById('sn-type');
    const snAuthorEl    = document.getElementById('sn-author');
    const snContentEl   = document.getElementById('sn-content');
    const snRefEl       = document.getElementById('sn-ref');
    const snChainEl     = document.getElementById('sn-chain');
    const snAmountEl    = document.getElementById('sn-amount');
    const snGasEl       = document.getElementById('sn-gas');
    const snModeEl      = document.getElementById('sn-mode');
    const snCaEl        = document.getElementById('sn-ca');
    const snRouterEl    = document.getElementById('sn-router');
    const snDryRunEl    = document.getElementById('sn-dryrun');
    const snGasLimitEl  = document.getElementById('sn-gaslimit');
    const snSlippageEl  = document.getElementById('sn-slippage');
    const snDeadlineEl  = document.getElementById('sn-deadline');
    const snRaydiumEl   = document.getElementById('sn-raydiumca');
    const snSpecialEl   = document.getElementById('sn-special');

    if (snNameEl)      snNameEl.value = '';
    if (snTypeEl)      snTypeEl.value = '';
    if (snModeEl)      snModeEl.value = 'pancake';
    if (snAuthorEl)    snAuthorEl.value = '';
    if (snContentEl)   snContentEl.value = '';
    if (snRefEl)       snRefEl.value = '';
    if (snChainEl)     snChainEl.value = 'bnb';
    if (snAmountEl)    snAmountEl.value = '';
    if (snGasEl)       snGasEl.value = '';
    if (snCaEl)        snCaEl.value = '';
    if (snRouterEl)    snRouterEl.value = '';
    if (snDryRunEl)    snDryRunEl.checked = false;
    if (snGasLimitEl)  snGasLimitEl.value = '';
    if (snSlippageEl)  snSlippageEl.value = '';
    if (snDeadlineEl)  snDeadlineEl.value = '';
    if (snRaydiumEl)   snRaydiumEl.value = '';
    if (snSpecialEl)   snSpecialEl.checked = false;
    if (SN_MULTIBUY)   SN_MULTIBUY.checked = false;
    const snNightModeEl = document.getElementById('sn-nightmode');
if (snNightModeEl) snNightModeEl.checked = false;

    // Clear night mode timing field - SIMPLIFIED
    const sellAfterEl = document.getElementById('sn-nm-sellafter');
    if (sellAfterEl) sellAfterEl.value = '2';
    
    // Hide timing controls
    const nmTimingDiv = document.getElementById('nightmode-timing');
    if (nmTimingDiv) nmTimingDiv.style.display = 'none';

    // Switch to Orders tab to show result
    document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
    const ordersTab = document.querySelector('.tab[data-tab="orders"]');
    if (ordersTab) ordersTab.classList.add('active');

    document.querySelectorAll('.panel').forEach(p => p.classList.remove('active'));
    const panel = document.getElementById('panel-orders');
    if (panel) panel.classList.add('active');

    renderOrders();
  });

  // Render Orders tab on load too
  renderOrders();
  
  // Night mode checkbox toggle - show/hide timing controls
  const nightModeCheckbox = document.getElementById('sn-nightmode');
  const nightModeTimingDiv = document.getElementById('nightmode-timing');
  
  if (nightModeCheckbox && nightModeTimingDiv) {
    // Set initial state
    nightModeTimingDiv.style.display = nightModeCheckbox.checked ? 'block' : 'none';
    
    // Toggle on change
    nightModeCheckbox.addEventListener('change', () => {
      nightModeTimingDiv.style.display = nightModeCheckbox.checked ? 'block' : 'none';
    });
  }
});
