// popup.js — Uxento Injector (toaster-compatible, single-URL)
const $ = (id) => document.getElementById(id);
let CONFIG = null;

document.addEventListener('DOMContentLoaded', () => {
  bindUI();
  log('Injector ready.');
});

function bindUI() {
  $('btnLoadCfg')?.addEventListener('click', loadConfig);
  $('btnApplyType')?.addEventListener('click', applyProfileToForm);
  $('inject1')?.addEventListener('click', () => runInjection(1));
  $('inject5')?.addEventListener('click', () => runInjection(5));
  $('btnPing')?.addEventListener('click', pingTab);
  $('btnOutline')?.addEventListener('click', () => runInPage(outlineCards));
  $('btnClearMine')?.addEventListener('click', () => runInPage(clearInjectedByInjector));
  $('btnForceMutation')?.addEventListener('click', () => runInPage(forceMutationEvent));
}

function log(s) {
  const el = $('log'); if (!el) return;
  el.textContent += (el.textContent ? '\n' : '') + s;
  el.scrollTop = el.scrollHeight;
}

// ---------- config helpers ----------
async function loadConfig() {
  try {
    const url = chrome.runtime.getURL('uxento.config.json');
    const res = await fetch(url);
    CONFIG = await res.json();
    log('Loaded config.');
    if (CONFIG?.defaults) {
      $('includeLinks').checked = !!CONFIG.defaults.includeLinks;
      $('dbgFlash').checked = !!(CONFIG.defaults.debug?.flashInjected ?? true);
      $('dbgConsole').checked = !!(CONFIG.defaults.debug?.logToConsole ?? true);
      $('dbgDataAttrs').checked = !!(CONFIG.defaults.debug?.addDataAttrs ?? true);
    }
  } catch (e) {
    log('Config load failed: ' + (e?.message || e));
  }
}

function applyProfileToForm() {
  if (!CONFIG) return log('Load config first.');
  const t = $('type').value;
  const p = CONFIG.profiles?.[t];
  if (!p) return log('No profile for ' + t);

  $('name').value = p.name ?? '';
  $('handle').value = p.handle ?? '';
  $('body').value = p.body ?? '';
    $('name').value = p.name ?? '';
  $('handle').value = p.handle ?? '';
  $('body').value = p.body ?? '';

  if ($('mediaUrl')) {
    $('mediaUrl').value = p.mediaUrl ?? '';
  }


  const handleNoAt = (p.handle || 'user').replace(/^@/, '');

  const ref =
    (t === 'tweet' && p.statusId)
      ? `https://x.com/${handleNoAt}/status/${p.statusId}`
      : (p.referencedUrl)
        ? p.referencedUrl
        : (p.targetId)
          ? `https://x.com/i/web/status/${p.targetId}`
          : '';

  $('referencedUrl').value = ref;

  if (typeof p.includeLinks === 'boolean') {
    $('includeLinks').checked = p.includeLinks;
  }
}

// ---------- core ----------
async function getActiveTab(){ const [t] = await chrome.tabs.query({active:true,currentWindow:true}); return t; }
function sleep(ms){ return new Promise(r => setTimeout(r, ms)); }

async function runInjection(n=1) {
  const tab = await getActiveTab();
  if (!tab) return log('No active tab');

  const payload = makePayload();

  for (let i=0;i<n;i++) {
    try {
      const [{ result }] = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: pageInjectCard,
        args: [payload]
      });
      log(JSON.stringify(result));
    } catch (e) {
      log('Injection error: ' + (e?.message || e));
    }
    await sleep(100);
  }
}

function makePayload() {
  const type = $('type').value;
  const name = $('name').value.trim() || 'Anon';
  const handle = $('handle').value.trim().replace(/^@/, '') || 'anon';
  const body = $('body').value;
  const referencedUrl = ($('referencedUrl')?.value || '').trim(); // tweet being replied to / quoted / retweeted
  const includeLinks = $('includeLinks').checked;
  const mediaUrl = ($('mediaUrl')?.value || '').trim();           // NEW: attached media

  const debug = {
    flashInjected: $('dbgFlash')?.checked ?? true,
    logToConsole: $('dbgConsole')?.checked ?? true,
    addDataAttrs: $('dbgDataAttrs')?.checked ?? true
  };

  return { type, name, handle, body, referencedUrl, includeLinks, mediaUrl, debug };
}


// ---------- utilities for runInPage buttons ----------
async function runInPage(fn) {
  const tab = await getActiveTab(); if (!tab) return log('No active tab');
  const [{ result }] = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    func: fn
  });
  log(JSON.stringify(result));
}

function outlineCards() {
  const sel = 'div[data-card="true"], article.relative.font-geist.rounded-md.border.overflow-hidden';
  const nodes = document.querySelectorAll(sel);
  nodes.forEach((n,i)=>{
    n.style.outline='2px solid #0b7cff';
    n.style.outlineOffset='2px';
    n.dataset._uxentoOutlined='1';
  });
  return { outlined: nodes.length };
}

function clearInjectedByInjector(){
  const mine = document.querySelectorAll('.uxento-injector-card');
  const n=mine.length;
  mine.forEach(n=>n.remove());
  return { removed:n };
}

function forceMutationEvent(){
  const e=new CustomEvent('uxento:force-mutation',{detail:Date.now()});
  window.dispatchEvent(e);
  return { ok:true, detail:e.detail };
}

// ===================================================================
// PAGE FUNCTION: builds DOM that matches toaster/sniper detectors
// ===================================================================
function pageInjectCard(p) {
  try {
    
    const type = (p.type || 'tweet').toLowerCase();
    const name = (p.name || 'Anon');
    const handle = (p.handle || 'anon').replace(/^@/, '');
    const handleAt = '@' + handle;
    const body = p.body || '';
    const refUrl = (p.referencedUrl || '').trim(); // ONE reference tweet URL
    const includeLinks = !!p.includeLinks;
    const mediaUrl = (p.mediaUrl || '').trim();

    // helper: <a>
    const a = (href, text) => {
      const el = document.createElement('a');
      el.href = href;
      el.textContent = text || href;
      el.target = '_blank';
      el.rel = 'noopener noreferrer';
      return el;
    };

    // root matches CARD_CANDIDATE_SELECTOR from toaster
    const root = document.createElement('div');
    root.setAttribute('data-card', 'true');
    root.className = 'uxento-injector-card';

    const article = document.createElement('article');
    article.className = 'relative font-geist rounded-md border overflow-hidden';
    article.style.cssText = 'background:#0d0f14;border:1px solid #22263a;border-radius:12px;padding:6px 0;';
    root.appendChild(article);

    // ---------- CONTEXT HEADER (reply / retweet ribbon)
    // reply => `Replying to <refUrl>`
    if (type === 'reply') {
      const helper = document.createElement('div');
      helper.className = 'px-3 text-xs';
      helper.textContent = 'Replying to ';
      if (refUrl) helper.appendChild(a(refUrl));
      article.appendChild(helper);
    }

    // retweet => `<@me> retweeted <refUrl>`
    // sniper/toaster expects a ribbon row with TWO anchors:
    //   1) retweeter handle
    //   2) referenced/original tweet URL
    if (type === 'retweet') {
      const rib = document.createElement('div');
      rib.className = 'flex items-center gap-2 px-3 pb-2 text-xs text-[#6C6C7D]';

      // who is doing the retweet
      const meAnchor = a('https://x.com/' + handle, handleAt);
      rib.appendChild(meAnchor);

      const span = document.createElement('span');
      span.textContent = 'retweeted';
      span.className = 'opacity-70';
      rib.appendChild(span);

      // original tweet being retweeted = refUrl
      if (refUrl) {
        const refAnchor = a(refUrl, refUrl);
        rib.appendChild(refAnchor);
      }

      article.appendChild(rib);
    }

    // ---------- AUTHOR HEADER
    const head = document.createElement('div');
    head.className = 'px-3 pt-2 flex items-center gap-3';

    const img = document.createElement('img');
    img.width=40; img.height=40;
    img.src = 'https://i.pravatar.cc/48?img='+(Math.floor(Math.random()*70)+1);
    img.style.borderRadius='9999px';
    img.style.objectFit='cover';
    img.referrerPolicy='no-referrer';

    const meta = document.createElement('div');
    meta.className = 'flex flex-col';

    const nm = document.createElement('span');
    nm.className = 'font-medium';
    nm.textContent = name;

    const hlink = a('https://x.com/' + handle, handleAt);
    hlink.style.color='#9aa3b2';
    hlink.style.textDecoration='none';
    hlink.style.fontSize='13px';

    meta.append(nm, hlink);
    head.append(img, meta);
    article.appendChild(head);

    // ---------- BODY TEXT
    const bodyWrap = document.createElement('div');
    bodyWrap.className = 'px-3 pb-2';

    const bodyDiv = document.createElement('div');
    bodyDiv.className = 'leading-relaxed break-words';
    bodyDiv.setAttribute('data-testid','tweetText');
    bodyDiv.textContent = body;

    bodyWrap.appendChild(bodyDiv);
    article.appendChild(bodyWrap);
        // ---------- MEDIA IMAGE (optional)
    if (mediaUrl) {
      const mediaWrap = document.createElement('div');
      mediaWrap.className = 'mt-1';
      mediaWrap.style.cssText = [
        'margin:0 12px 8px 12px',
        'border-radius:16px',
        'overflow:hidden',
        'border:1px solid #22263a',
        'background:#05060a'
      ].join(';');

      const mediaImg = document.createElement('img');
      mediaImg.src = mediaUrl;
      mediaImg.alt = '';
      mediaImg.style.cssText = [
        'display:block',
        'width:100%',
        'height:auto',
        'max-height:480px',
        'object-fit:cover'
      ].join(';');
      mediaImg.referrerPolicy = 'no-referrer';

      mediaWrap.appendChild(mediaImg);
      article.appendChild(mediaWrap);
    }


    // ---------- STATUS / URL ANCHORS
    // IMPORTANT: Status URL anchors MUST come before quote helper/quoted box
    // because getAuthorStatusUrl() picks the FIRST <a href="/status/"> in the card
    // selfUrl is a fake canonical status URL for *this* post instance
let selfUrl;
if (type === 'retweet' && refUrl) {
  // hijack: pretend THIS post's status URL IS the original tweet URL
  selfUrl = refUrl;
} else {
  // normal behavior for tweet / reply / quote
  selfUrl = `https://x.com/${handle}/status/${Date.now()}`;
}

if (includeLinks) {
  // CRITICAL ORDER for toaster detection:
  // - The FIRST <a href="/status/..."> is picked up by getAuthorStatusUrl() as the "author" URL
  // - For QUOTES: we want selfUrl FIRST (so it's the author), then refUrl SECOND (so it's detected as quoted)
  // - For REPLIES/RETWEETS: we want selfUrl FIRST, then refUrl SECOND (so it's detected as parent/retweeted)
  // - For TWEETS: just selfUrl

  const isContextual =
    (type === 'reply' || type === 'quote' || type === 'retweet') &&
    refUrl;

  if (isContextual) {
    // SELF row FIRST (this becomes the author URL in toaster's getAuthorStatusUrl)
    const selfRow = document.createElement('div');
    selfRow.className = 'px-3 pb-2 text-xs';
    selfRow.appendChild(a(selfUrl));
    article.appendChild(selfRow);

    // REFERENCE row SECOND (this will be detected as quoted/replied/retweeted URL)
    const refRow = document.createElement('div');
    refRow.className = 'px-3 pb-2 text-xs';
    refRow.appendChild(a(refUrl));
    article.appendChild(refRow);
  } else {
    // Normal tweet: just selfUrl
    const selfRow = document.createElement('div');
    selfRow.className = 'px-3 pb-2 text-xs';
    selfRow.appendChild(a(selfUrl));
    article.appendChild(selfRow);
  }
}

    // ---------- QUOTE BLOCK (quote type ONLY)
    // Place AFTER status URLs so getAuthorStatusUrl picks up selfUrl first
if (type === 'quote' && refUrl) {
  const quoteHelper = document.createElement('div');
  quoteHelper.className = 'px-3 text-xs';
  quoteHelper.textContent = 'Quoting ';
  quoteHelper.appendChild(a(refUrl, refUrl));
  article.appendChild(quoteHelper);

  const quotedBox = document.createElement('div');
  quotedBox.className = 'mx-3 mb-2 rounded border border-[#2a2f45] bg-[#141722] p-2 text-xs tweet__quoted';

  const qAnchor = a(refUrl, refUrl);
  qAnchor.style.wordBreak = 'break-all';

  quotedBox.appendChild(qAnchor);
  article.appendChild(quotedBox);
}


    // ---------- INSERT INTO PAGE
    const feed = document.querySelector('[data-uxento-feed]') ||
                 document.querySelector('main') ||
                 document.body;
    feed.prepend(root);

    // flash for visibility when injecting
    if (p.debug?.flashInjected) {
      root.animate(
        [{outline:'2px solid #4a5aff'},{outline:'0px solid transparent'}],
        {duration:500,iterations:1}
      );
    }

    // ---------- IMPORTANT PART FOR SNIPER MATCH ----------
    // Some of your sniper rules check "reference url" for quotes/retweets,
    // but your pipeline was treating statusUrl as the "main" URL.
    // We now force quotes/retweets to surface refUrl as the main statusUrl
    // so sniper can match on it immediately.
// ---------- IMPORTANT PART FOR SNIPER MATCH ----------
const mainUrlForSniper =
  ((type === 'quote' || type === 'retweet' || type === 'reply') && refUrl)
    ? refUrl
    : selfUrl;

return {
  ok: true,
  type,
  handle: handleAt,
  statusUrl: mainUrlForSniper, // <-- this is now correct
  refUrl: refUrl || '',
  selfUrl: selfUrl
};

  } catch (e) {
    return { ok:false, error: String(e) };
  }
}