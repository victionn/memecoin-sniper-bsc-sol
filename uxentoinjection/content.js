// Uxento Injector — Content script (HUD + Twitter-like card injectors, toaster-compatible)

const UXI = {
  DEBUG: true,
  counts: { tweet: 0, reply: 0, retweet: 0, quote: 0 },
  hud: null,
  logEl: null,
};

function clog(...args) {
  if (!UXI.DEBUG) return;
  console.log('[UxentoInjector/content]', ...args);
}

/* ---------------- HUD ---------------- */
function ensureHUD() {
  if (UXI.hud && document.body.contains(UXI.hud)) return UXI.hud;
  const hud = document.createElement('div');
  hud.id = 'uxiHud';
  hud.style.cssText = `
    position:fixed; right:12px; top:12px; z-index:2147483647;
    font: 12px/1.2 ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Arial, sans-serif;
    color:#dfe7ff; background:#0b0f1a; border:1px solid #223; border-radius:10px; padding:8px 10px;
    box-shadow:0 8px 24px rgba(0,0,0,.35);
  `;
  hud.innerHTML = `
    <div style="display:flex;gap:12px;align-items:center;margin-bottom:6px">
      <strong>Uxento Injector</strong>
      <button id="uxiToggle" style="cursor:pointer;padding:4px 8px;border-radius:6px;border:1px solid #2a2f44;background:#12162a;color:#cfe">
        toggle log
      </button>
    </div>
    <div style="display:flex;gap:10px;margin-bottom:6px">
      <div>tweet: <b id="cTweet">0</b></div>
      <div>reply: <b id="cReply">0</b></div>
      <div>retweet: <b id="cRetweet">0</b></div>
      <div>quote: <b id="cQuote">0</b></div>
    </div>
    <pre id="uxiLog" style="max-height:160px;overflow:auto;background:#0f1324;border:1px solid #243;padding:6px;border-radius:8px;margin:0"></pre>
  `;
  document.documentElement.appendChild(hud);
  hud.querySelector('#uxiToggle').addEventListener('click', () => setHUDVisible(UXI.hud.classList.contains('hidden')));
  UXI.hud = hud;
  UXI.logEl = hud.querySelector('#uxiLog');
  return hud;
}

function setHUDVisible(show) {
  ensureHUD();
  UXI.hud.classList.toggle('hidden', !show);
}
function logHUD(line) {
  ensureHUD();
  if (!UXI.logEl) return;
  const now = new Date().toLocaleTimeString();
  UXI.logEl.textContent += `[${now}] ${line}\n`;
  UXI.logEl.scrollTop = UXI.logEl.scrollHeight;
}
function updateCounts() {
  ensureHUD();
  UXI.hud.querySelector('#cTweet').textContent   = UXI.counts.tweet;
  UXI.hud.querySelector('#cReply').textContent   = UXI.counts.reply;
  UXI.hud.querySelector('#cRetweet').textContent = UXI.counts.retweet;
  UXI.hud.querySelector('#cQuote').textContent   = UXI.counts.quote;
}

/* ---------------- Helpers to build toaster-compatible cards ---------------- */
function sanitize(s){ return (s==null?'':String(s)); }
function asHandle(h){ h = sanitize(h).trim(); if (!h) return '@unknown'; return h.startsWith('@')? h : '@'+h; }
function userFromHandle(h){ return asHandle(h).replace(/^@/,''); }
function randId(){ return String(Math.floor(10**15 + Math.random()*9*10**15)); }
function ensureId(x){ return (String(x||'').match(/^\d+$/) ? String(x) : randId()); }

// A real avatar image (avoid letter avatars). Do NOT use .font-medium here.
function makeAvatar(srcUrl) {
  const wrap = document.createElement('div');
  wrap.className = 'px-3 pt-2';
  const box = document.createElement('div');
  box.style.cssText = 'width:40px;height:40px;border-radius:9999px;overflow:hidden;background:#0F0F17;border:1px solid #2A2A33';
  const img = document.createElement('img');
  img.alt = '';
  img.src = srcUrl || 'https://abs.twimg.com/sticky/default_profile_images/default_profile_normal.png';
  img.style.cssText = 'width:100%;height:100%;object-fit:cover;display:block';
  box.appendChild(img);
  wrap.appendChild(box);
  return wrap;
}

// header with author .font-medium and handle anchor (toaster reads these)
function makeHeader(name, handle) {
  const row = document.createElement('div');
  row.className = 'group flex flex-col px-3 pt-1'; // keep separate from avatar so .font-medium is definitely the name

  const nm = document.createElement('span');
  nm.className = 'font-medium';
  nm.textContent = sanitize(name || 'Unknown');

  const a = document.createElement('a');
  a.href = `https://x.com/${userFromHandle(handle)}`;
  a.textContent = asHandle(handle);
  a.style.marginTop = '2px';

  row.appendChild(nm);
  row.appendChild(a);
  return row;
}

// body container: .px-3.pb-2 + [data-testid="tweetText"].leading-relaxed.break-words
function makeBody(text) {
  const bodyWrap = document.createElement('div');
  bodyWrap.className = 'px-3 pb-2';
  const txt = document.createElement('div');
  txt.setAttribute('data-testid', 'tweetText');
  txt.className = 'leading-relaxed break-words';
  txt.textContent = sanitize(text);
  bodyWrap.appendChild(txt);
  return bodyWrap;
}

// 'Replying to …' helper row (.px-3.text-xs)
function makeHelperRow(text) {
  const row = document.createElement('div');
  row.className = 'px-3 text-xs';
  row.textContent = text;
  return row;
}

// quoted block as a visible anchor (toaster will extract)
function makeQuotedLink(url) {
  if (!url) return null;
  const wrap = document.createElement('div');
  wrap.className = 'px-3 pb-2';
  const a = document.createElement('a');
  a.href = url;
  a.textContent = url;
  wrap.appendChild(a);
  return wrap;
}

// ONE canonical status anchor for THIS tweet (hidden)
function makeCanonicalStatusAnchor(user, id) {
  const a = document.createElement('a');
  a.href = `https://x.com/${user}/status/${id}`;
  a.textContent = a.href;
  a.style.cssText = 'display:none';
  return a;
}

/* ---------------- Card builder ---------------- */
/* ---------------- Card builder (NEW Uxento 2025 layout) ---------------- */
function buildCard(kind, payload={}){
  const host = document.querySelector('[data-reactroot], main, body') || document.body;

  const card = document.createElement('article');  // ✅ Changed to article
  card.setAttribute('data-card', 'true');
  // ✅ Updated classes to match new layout
  card.className = 'relative rounded-lg border-2 overflow-hidden w-full max-w-full min-w-0 bg-[#15151f] border-[#1A1A23]/50';

  const name    = sanitize(payload.author || 'Anon');
  const handle  = asHandle(payload.handle || '@anon');
  const bodyTxt = sanitize(payload.text || '');
  const selfId  = ensureId(payload.statusId);
  const selfUser = userFromHandle(handle);

  // Avatar (unchanged)
  card.appendChild(makeAvatar(payload.avatarUrl || `https://pbs.twimg.com/profile_images/441963.../elon_normal.jpeg`));

  // Header (unchanged)
  card.appendChild(makeHeader(name, handle));

  // 🔹 NEW: Reply/Quote ribbons with new layout
  if (kind === 'reply') {
    const replyTo = asHandle(payload.replyTo || handle);
    card.appendChild(makeNewReplyRibbon(replyTo));
  }
  
  if (kind === 'quote') {
    const quotedHandle = payload.quotedHandle || '@someone';
    card.appendChild(makeNewQuoteRibbon(quotedHandle));
  }

  // Body text
  card.appendChild(makeBody(bodyTxt));

  if (kind === 'reply') {
    const parentUrl = payload.parentUrl || payload.repliedUrl || 
                      `https://x.com/someuser/status/${randId()}`;
    
    const replyBox = document.createElement('div');
    replyBox.className = 'px-3 pb-2';
    const a = document.createElement('a');
    a.href = parentUrl;
    a.textContent = parentUrl;
    replyBox.appendChild(a);
    card.appendChild(replyBox);

    card.appendChild(makeCanonicalStatusAnchor(selfUser, selfId));

  } else if (kind === 'quote') {
    const qurl = payload.quotedUrl || payload.targetUrl || 
                 `https://x.com/someone/status/${randId()}`;
    
    const q = makeQuotedLink(qurl);
    if (q) card.appendChild(q);
    
    card.appendChild(makeCanonicalStatusAnchor(selfUser, selfId));

  } else {
    card.appendChild(makeCanonicalStatusAnchor(selfUser, selfId));
  }

  host.prepend(card);
  return card;
}

// ✅ NEW: Reply ribbon matching new Uxento layout
function makeNewReplyRibbon(replyToHandle) {
  const ribbon = document.createElement('span');
  ribbon.className = 'text-[13px] text-muted-foreground leading-none flex items-center gap-1.5 px-3 pb-2';
  
  // Add Lucide reply icon (SVG)
  const icon = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  icon.classList.add('lucide-message-square-reply');
  icon.setAttribute('width', '16');
  icon.setAttribute('height', '16');
  icon.setAttribute('viewBox', '0 0 24 24');
  icon.setAttribute('fill', 'none');
  icon.setAttribute('stroke', 'currentColor');
  icon.setAttribute('stroke-width', '2');
  icon.innerHTML = '<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>';
  
  ribbon.appendChild(icon);
  
  const text = document.createElement('span');
  text.textContent = `ReplyingNIGGAAA ${replyToHandle}`;
  ribbon.appendChild(text);
  
  return ribbon;
}

// ✅ NEW: Quote ribbon matching new Uxento layout
function makeNewQuoteRibbon(quotedHandle) {
  const ribbon = document.createElement('span');
  ribbon.className = 'text-[13px] text-muted-foreground leading-none flex items-center gap-1.5 px-3 pb-2';
  
  // Add quote icon
  const icon = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  icon.setAttribute('width', '16');
  icon.setAttribute('height', '16');
  icon.setAttribute('viewBox', '0 0 24 24');
  icon.setAttribute('fill', 'none');
  icon.setAttribute('stroke', 'currentColor');
  icon.setAttribute('stroke-width', '2');
  icon.innerHTML = '<path d="M7.9 20A9 9 0 1 0 4 16.1L2 22Z"/>';
  
  ribbon.appendChild(icon);
  
  const text = document.createElement('span');
  text.textContent = `Quoting ${quotedHandle}`;
  ribbon.appendChild(text);
  
  return ribbon;
}

/* ---------------- Public API used by popup/bg ---------------- */
function injectSimulated(kind, payload) {
  const card = buildCard(kind, payload || {});
  // Hint the toaster (if present on page)
  try {
    if (typeof findTopmostCard === 'function' && typeof schedule === 'function') {
      const top = findTopmostCard(card);
      if (top) schedule(top);
    }
  } catch(_) {}

  UXI.counts[kind] = (UXI.counts[kind] || 0) + 1;
  updateCounts();
  logHUD(`Injected ${kind}`);
  return { ok:true, kind };
}

/* ---------------- Message listener ---------------- */
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    try {
      if (!msg || !msg.type) {
        sendResponse({ ok:false, error:'no type' });
        return;
      }

      if (msg.type === 'content.ping') {
        sendResponse({ ok:true, hello:'content', url: location.href });
        return;
      }

      if (msg.type === 'content.setDebug') {
        UXI.DEBUG = !!msg.payload?.enable;
        clog('set DEBUG', UXI.DEBUG);
        sendResponse({ ok:true });
        return;
      }

      if (msg.type === 'content.hud') {
        setHUDVisible(!!msg.payload?.show);
        sendResponse({ ok:true, visible: !UXI.hud.classList.contains('hidden') });
        return;
      }

      if (msg.type === 'content.inject') {
        const kind = msg.payload?.kind || 'tweet';
        const payload = msg.payload?.payload || {};
        const res = injectSimulated(kind, payload);
        sendResponse(res);
        return;
      }

      sendResponse({ ok:false, error:`unknown content message ${msg.type}` });
    } catch (e) {
      clog('handler error', e);
      sendResponse({ ok:false, error: String(e) });
    }
  })();
  return true;
});

/* ---------------- Boot ---------------- */
ensureHUD();
setHUDVisible(false);
clog('Content ready.');
