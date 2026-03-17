// ═══════════════════════════════════════════════════════════════════════════════
// content_uxento_v2.js - Uxento Tweet Monitor (Ably-first architecture)
// ═══════════════════════════════════════════════════════════════════════════════
// V2 Changes:
// - Ably (__uxentoTweetMap) as SINGLE SOURCE OF TRUTH for author/body/refUrls
// - Removed all retry logic (waitForBetterBody, rescanQuoteLater, etc.)
// - Removed old HTML layout detection - simplified DOM extraction
// - Removed image extraction logic - hasImage always false
// - Kept: timings, toasts, audio, bg.js contract, deduplication
// ═══════════════════════════════════════════════════════════════════════════════

(() => {
'use strict';

// ═══════════════════════════════════════════════════════════════════════════════
// SECTION 1: CONFIGURATION & CONSTANTS
// ═══════════════════════════════════════════════════════════════════════════════

const CONFIG = {
  // Feature flags
  ENABLE_DEBUG: true,
  ENABLE_PERF_TIMING: true,
  
  // Deduplication
  TWEET_TTL_MS: 60_000, // 60s
  
  // DOM selectors (new Uxento 2025 layout + old layout fallback)
  CARD_SELECTOR: [
    'article.relative.rounded-lg.border-2.overflow-hidden.w-full.max-w-full.min-w-0', // New layout
    'div[data-card="true"]', // Old layout fallback
    'article.relative.font-geist.rounded-md.border.overflow-hidden' // Older layout
  ].join(', ')
};

// ═══════════════════════════════════════════════════════════════════════════════
// SECTION 2: UTILITY FUNCTIONS
// ═══════════════════════════════════════════════════════════════════════════════

function debug(...args) {
  if (!CONFIG.ENABLE_DEBUG) return;
  console.log('[uxento-v2]', ...args);
}

function normalizeUrl(url) {
  if (!url) return '';
  try {
    const u = new URL(url);
    return `${u.origin}${u.pathname}`;
  } catch {
    return String(url);
  }
}

function extractTweetIdFromUrl(url) {
  if (!url) return null;
  const m = String(url).match(/\/status\/(\d+)/);
  return m ? m[1] : null;
}

function nowHHMMSS() {
  const d = new Date();
  return [d.getHours(), d.getMinutes(), d.getSeconds()]
    .map(n => String(n).padStart(2, '0'))
    .join(':');
}

// ═══════════════════════════════════════════════════════════════════════════════
// SECTION 3: TWEET MAP SERVICE (Ably Integration)
// ═══════════════════════════════════════════════════════════════════════════════

class TweetMapService {
  constructor() {
    this.tweetMap = window.__uxentoTweetMap || {};
  }

  /**
   * Get tweet data from Ably tweetMap by ID
   */
  getById(tweetId) {
    if (!tweetId) return null;
    return this.tweetMap[tweetId] || null;
  }

  /**
   * Get tweet data by URL (extracts ID from URL)
   */
  getByUrl(url) {
    const id = extractTweetIdFromUrl(url);
    return id ? this.getById(id) : null;
  }

  /**
   * Get reference URL for a tweet (parent/quoted/retweeted)
   */
  getReferenceUrl(tweetData) {
    if (!tweetData) return null;
    
    // Priority order: refUrl (reply parent) > quotedUrl > retweetedUrl
    return tweetData.refUrl || 
           tweetData.quotedUrl || 
           tweetData.retweetedUrl || 
           null;
  }

  /**
   * Get tweet type from Ably data
   */
  getTweetType(tweetData) {
    if (!tweetData || !tweetData.type) return 'tweet';
    
    const type = tweetData.type.toUpperCase();
    
    if (type === 'REPLY') return 'reply';
    if (type === 'RETWEET') return 'retweet';
    if (type === 'QUOTE_TWEET' || type === 'QUOTE') return 'quote';
    
    return 'tweet';
  }

  /**
   * Extract body text from Ably data
   */
  getBodyText(tweetData) {
    if (!tweetData) return '';
    
    const body = tweetData.body || {};
    return body.rawText || body.text || body.full_text || '';
  }

  /**
   * Debug: print tweetMap stats
   */
  getStats() {
    const ids = Object.keys(this.tweetMap);
    const types = {};
    
    ids.forEach(id => {
      const t = this.tweetMap[id].type || 'unknown';
      types[t] = (types[t] || 0) + 1;
    });
    
    return {
      total: ids.length,
      types
    };
  }
}

const tweetMapService = new TweetMapService();
// Store pending tweets waiting for reference URLs
const pendingReferenceUrls = new Map(); // tweetId -> { resolve, timeout }

// Listen for tweetMap updates
window.addEventListener('message', (event) => {
  if (event.source !== window) return;
  if (event.data?.type === 'TWEETMAP_UPDATED') {
    const { tweetId, hasReferenceUrl } = event.data;
    if (hasReferenceUrl && pendingReferenceUrls.has(tweetId)) {
      const { resolve, timeout } = pendingReferenceUrls.get(tweetId);
      clearTimeout(timeout);
      pendingReferenceUrls.delete(tweetId);
      debug('Reference URL arrived for:', tweetId);
      resolve();
    }
  }
});
// ═══════════════════════════════════════════════════════════════════════════════
// SECTION 4: DOM EXTRACTION (Minimal - Tweet IDs Only)
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Extract tweet ID from card DOM - now extracts all IDs and finds best match
 */
function extractTweetIdFromCard(card) {
  const links = card.querySelectorAll('a[href*="/status/"], a[href*="/i/web/status/"]');
  const ids = [];
  
  for (const link of links) {
    const href = link.getAttribute('href') || link.href || '';
    const id = extractTweetIdFromUrl(href);
    if (id) ids.push(id);
  }
  
  if (ids.length === 0) return null;
  
  ids.sort((a, b) => Number(b) - Number(a));
  
  // ✅ NEW: Check if any ID was recently retweeted (within last 5 seconds)
  const now = Date.now();
  for (const id of ids) {
    const entry = tweetMapService.getById(id);
    if (!entry) continue;
    
    // If this tweet was recently retweeted, return the retweet ID instead
    if (entry.retweetedBy && entry.retweetedBy.length > 0) {
      const recentRetweet = entry.retweetedBy
        .filter(rt => rt.timestamp && (now - rt.timestamp) < 5000)
        .sort((a, b) => b.timestamp - a.timestamp)[0];
      
      if (recentRetweet) {
        debug('Found recent retweet:', recentRetweet.id, 'of original:', id);
        return recentRetweet.id;
      }
    }
  }
  
  // Original logic: prioritize tweets with relationships
  for (const id of ids) {
    const entry = tweetMapService.getById(id);
    if (!entry) continue;
    
    const type = (entry.type || '').toUpperCase();
    
    if (['REPLY', 'RETWEET', 'QUOTE_TWEET', 'QUOTE'].includes(type)) {
      return id;
    }
  }
  
  return ids[0];
}

/**
 * Extract URLs from text
 */
function extractUrls(text) {
  if (!text) return [];
  const matches = text.match(/https?:\/\/[^\s]+/g) || [];
  return matches;
}

// ═══════════════════════════════════════════════════════════════════════════════
// SECTION 5: PERFORMANCE TIMING
// ═══════════════════════════════════════════════════════════════════════════════

class CardTimer {
  constructor(cardKey) {
    this.cardKey = cardKey;
    this.timestamps = {};
    this.start = performance.now();
    this.mark('detected');
  }
  
  mark(label) {
    if (!CONFIG.ENABLE_PERF_TIMING) return;
    this.timestamps[label] = performance.now();
  }
  
  report(finalLabel = 'complete') {
    if (!CONFIG.ENABLE_PERF_TIMING) return;
    
    this.mark(finalLabel);
    
    const stages = Object.keys(this.timestamps).sort((a, b) => 
      this.timestamps[a] - this.timestamps[b]
    );
    
    const breakdown = {};
    for (let i = 0; i < stages.length - 1; i++) {
      const from = stages[i];
      const to = stages[i + 1];
      breakdown[`${from}→${to}`] = (this.timestamps[to] - this.timestamps[from]).toFixed(1) + 'ms';
    }
    
    const total = (this.timestamps[finalLabel] - this.start).toFixed(1);
    
    console.log(`[⏱️ PERF] ${this.cardKey.slice(0, 30)}... | Total: ${total}ms`, {
      breakdown,
      timestamps: Object.keys(this.timestamps).reduce((acc, key) => {
        acc[key] = `+${(this.timestamps[key] - this.start).toFixed(1)}ms`;
        return acc;
      }, {})
    });
  }
}

const cardTimers = new Map();

// ═══════════════════════════════════════════════════════════════════════════════
// SECTION 6: DEDUPLICATION
// ═══════════════════════════════════════════════════════════════════════════════

// Card-level deduplication (prevent processing same card multiple times)
const processedAttr = '__memebuySeen';
const processedRunId = String(Date.now());
const seenKeys = new Map(); // card key -> timestamp
const DEDUPE_TTL_MS = 10 * 60 * 1000; // 10 minutes

function getCardKey(card) {
  // Try to get tweet ID and create a stable key
  const tweetId = extractTweetIdFromCard(card);
  if (tweetId) {
    return `tweet:${tweetId}`;
  }
  
  // Fallback: use all status URLs in card
  const links = card.querySelectorAll('a[href*="/status/"]');
  const urls = [];
  for (const link of links) {
    const url = normalizeUrl(link.getAttribute('href') || link.href || '');
    if (url) urls.push(url);
  }
  
  if (urls.length > 0) {
    return `urls:${urls.join('|')}`;
  }
  
  // Last resort: use position + text hash
  const text = (card.innerText || '').slice(0, 100);
  return `fallback:${text.length}:${text.slice(0, 20)}`;
}

function isAlreadySeen(key) {
  const now = Date.now();
  const ts = seenKeys.get(key);
  
  if (ts && (now - ts) < DEDUPE_TTL_MS) {
    return true;
  }
  
  // Cleanup old entries periodically
  if (seenKeys.size > 500) {
    for (const [k, t] of seenKeys) {
      if ((now - t) >= DEDUPE_TTL_MS) {
        seenKeys.delete(k);
      }
    }
  }
  
  return false;
}

function markSeen(key) {
  seenKeys.set(key, Date.now());
}

function isProcessed(card) {
  return !!(card && card.dataset && card.dataset[processedAttr] === processedRunId);
}

function markProcessed(card) {
  if (!card || !card.dataset) return;
  card.dataset[processedAttr] = processedRunId;
}

// BG notification deduplication (prevent sending same tweet to bg.js multiple times)
if (!window.__MBU_BG_SEEN_TWEETS__) {
  window.__MBU_BG_SEEN_TWEETS__ = {};
}

function shouldSendToBg(tweetUrl) {
  const key = normalizeUrl(tweetUrl);
  if (!key) return true;
  
  const now = Date.now();
  const prev = window.__MBU_BG_SEEN_TWEETS__[key];
  
  if (prev && (now - prev) < CONFIG.TWEET_TTL_MS) {
    debug('BG dedupe: skipping', key);
    return false;
  }
  
  window.__MBU_BG_SEEN_TWEETS__[key] = now;
  return true;
}

// ═══════════════════════════════════════════════════════════════════════════════
// SECTION 7: BACKGROUND COMMUNICATION
// ═══════════════════════════════════════════════════════════════════════════════

async function notifyBackground(payload) {
  console.log('[uxento-v2] 🚨 notifyBackground called with:', {
    handle: payload.handle,
    tweetType: payload.tweetType,
    statusUrl: payload.statusUrl,
    textLength: payload.text?.length
  });
  
  if (!shouldSendToBg(payload.statusUrl)) {
    debug('Skipped bg notification (dedupe):', payload.statusUrl);
    console.log('[uxento-v2] ⏭️ Skipped (dedupe)');
    return;
  }
  
  console.log('[uxento-v2] ✅ Passed dedupe check');
  
  try {
    const messageToSend = { 
      type: 'UXENTO_TO_BRIDGE',
      payload: { type: 'tweet_event', payload }
    };
    
    console.log('[uxento-v2] 📤 Posting message to bridge:', messageToSend);
    
    window.postMessage(messageToSend, '*');
    
    console.log('[uxento-v2] ✅ Message posted to bridge successfully');
  } catch (e) {
    console.error('[uxento-v2] ❌ notifyBackground error:', e);
    debug('notifyBackground error:', e);
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// SECTION 8: TOAST NOTIFICATIONS (Kept from v1)
// ═══════════════════════════════════════════════════════════════════════════════

if (!window.__uxentoRecentToasts) {
  window.__uxentoRecentToasts = [];
}

window.__recordRecentToast = (data) => {
  window.__uxentoRecentToasts.push(data);
  if (window.__uxentoRecentToasts.length > 50) {
    window.__uxentoRecentToasts.shift();
  }
};

function copyTextAllBrowsers(text) {
  return new Promise((resolve) => {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(resolve).catch(resolve);
    } else {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      document.body.removeChild(ta);
      resolve();
    }
  });
}

// Toast container management
let toastContainer = null;

function ensureToastContainer() {
  if (!toastContainer) {
    toastContainer = document.createElement('div');
    toastContainer.id = 'uxento-toast-container';
    toastContainer.style.cssText = `
      position: fixed;
      bottom: 20px;
      right: 20px;
      z-index: 999999;
      display: flex;
      flex-direction: column;
      gap: 10px;
      max-width: 400px;
    `;
    document.body.appendChild(toastContainer);
  }
  return toastContainer;
}

function makeToast({ title, preview, onCopyText, onCopyHtml, onCopyLinks, onRefresh, extraButtons = [] }) {
  const toastEl = document.createElement('div');
  toastEl.style.cssText = `
    background: #1a1a1a;
    border: 1px solid #333;
    border-radius: 8px;
    padding: 12px;
    color: #fff;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    font-size: 13px;
    box-shadow: 0 4px 12px rgba(0,0,0,0.5);
    max-width: 400px;
    animation: slideIn 0.3s ease-out;
  `;

  const titleEl = document.createElement('div');
  titleEl.style.cssText = 'font-weight: 600; margin-bottom: 8px; color: #4a9eff;';
  titleEl.textContent = title;

  const previewEl = document.createElement('div');
  previewEl.style.cssText = 'margin-bottom: 10px; line-height: 1.4; max-height: 100px; overflow-y: auto;';
  previewEl.textContent = preview.slice(0, 200);

  const buttonRow = document.createElement('div');
  buttonRow.style.cssText = 'display: flex; gap: 6px; flex-wrap: wrap;';

  const buttons = [
    { label: 'Text', handler: onCopyText },
    { label: 'HTML', handler: onCopyHtml },
    { label: 'Links', handler: onCopyLinks },
    { label: '🔄', handler: onRefresh },
    ...extraButtons
  ].filter(b => b.handler);

  buttons.forEach(({ label, handler }) => {
    const btn = document.createElement('button');
    btn.textContent = label;
    btn.style.cssText = `
      padding: 4px 8px;
      background: #2a2a2a;
      border: 1px solid #444;
      border-radius: 4px;
      color: #fff;
      cursor: pointer;
      font-size: 11px;
    `;
    btn.addEventListener('click', async () => {
      try {
        await handler();
        btn.textContent = '✓';
        setTimeout(() => btn.textContent = label, 1000);
      } catch (e) {
        btn.textContent = '✗';
        setTimeout(() => btn.textContent = label, 1000);
      }
    });
    buttonRow.appendChild(btn);
  });

  // Close button
  const closeBtn = document.createElement('button');
  closeBtn.textContent = '×';
  closeBtn.style.cssText = `
    position: absolute;
    top: 8px;
    right: 8px;
    background: transparent;
    border: none;
    color: #888;
    font-size: 18px;
    cursor: pointer;
    padding: 0;
    width: 20px;
    height: 20px;
    line-height: 1;
  `;
  closeBtn.addEventListener('click', () => {
    toastEl.style.animation = 'slideOut 0.2s ease-in';
    setTimeout(() => toastEl.remove(), 200);
  });

  toastEl.style.position = 'relative';
  toastEl.appendChild(closeBtn);
  toastEl.appendChild(titleEl);
  toastEl.appendChild(previewEl);
  toastEl.appendChild(buttonRow);

  // Auto-dismiss after 15s
  setTimeout(() => {
    if (toastEl.parentElement) {
      toastEl.style.animation = 'slideOut 0.2s ease-in';
      setTimeout(() => toastEl.remove(), 200);
    }
  }, 15000);

  return toastEl;
}

function pushToast(toastEl) {
  const container = ensureToastContainer();
  container.appendChild(toastEl);
}

// Add CSS animations
if (!document.getElementById('uxento-toast-styles')) {
  const style = document.createElement('style');
  style.id = 'uxento-toast-styles';
  style.textContent = `
    @keyframes slideIn {
      from { transform: translateX(400px); opacity: 0; }
      to { transform: translateX(0); opacity: 1; }
    }
    @keyframes slideOut {
      from { transform: translateX(0); opacity: 1; }
      to { transform: translateX(400px); opacity: 0; }
    }
  `;
  document.head.appendChild(style);
}

// ═══════════════════════════════════════════════════════════════════════════════
// SECTION 9: AUDIO SYSTEM (Kept from v1)
// ═══════════════════════════════════════════════════════════════════════════════

if (!window.__MBU_SOUND_READY__) {
  window.__MBU_SOUND_READY__ = true;

  let audioElement = null;
  let stopTimer = null;

  const hasChromeRuntime =
    typeof chrome !== 'undefined' &&
    chrome.runtime &&
    typeof chrome.runtime.getURL === 'function' &&
    chrome.runtime.onMessage &&
    typeof chrome.runtime.onMessage.addListener === 'function';

  if (hasChromeRuntime) {
    // Track user interaction for autoplay policy
    ['click', 'pointerdown', 'keydown', 'touchstart'].forEach(ev =>
      window.addEventListener(ev, () => {}, { once: true, passive: true })
    );

    // Create audio element
    try {
      audioElement = document.createElement('audio');
      audioElement.id = 'ding';
      audioElement.preload = 'auto';
      audioElement.src = chrome.runtime.getURL('ding.mp3');
      audioElement.volume = 1.0;
      audioElement.style.display = 'none';
      document.body.appendChild(audioElement);
      debug('Audio preloaded');
    } catch (e) {
      debug('Audio create failed:', e);
    }

    async function playDing() {
      try {
        if (!audioElement) return;

        if (stopTimer) {
          clearTimeout(stopTimer);
          stopTimer = null;
        }

        audioElement.currentTime = 0;
        const p = audioElement.play();
        
        if (p && p.then) {
          p.then(() => {
            debug('Audio playing');
            stopTimer = setTimeout(() => {
              audioElement.pause();
              audioElement.currentTime = 0;
            }, 15000);
          }).catch(err => debug('Audio blocked:', err.message));
        }
      } catch (e) {
        debug('Audio play error:', e);
      }
    }

    chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
      if (msg && msg.type === 'play_sniper_sound') {
        playDing();
        sendResponse && sendResponse({ ok: true });
        return false;
      }
    });
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// SECTION 10: CARD PROCESSING (Main Logic - Ably-first)
// ═══════════════════════════════════════════════════════════════════════════════

async function processCard(card) {
  // ──────────────────────────────────────────────────────────────────────────────
  // STEP 0: Check if already processed (EARLY EXIT)
  // ──────────────────────────────────────────────────────────────────────────────
  if (isProcessed(card)) {
    debug('Card already processed, skipping');
    return;
  }

  // Generate stable key for this card
  const key = getCardKey(card);
  
  // Check if we've seen this card recently
  if (isAlreadySeen(key)) {
    debug('Card already seen recently, skipping:', key);
    markProcessed(card); // Still mark to prevent re-checking
    return;
  }

  // Mark as seen
  markSeen(key);

  const timer = new CardTimer(key);
  cardTimers.set(card, timer);

  debug('Processing card:', key);

  // ──────────────────────────────────────────────────────────────────────────────
  // STEP 1: Extract tweet ID from DOM
  // ──────────────────────────────────────────────────────────────────────────────
  timer.mark('extractId');
  const tweetId = extractTweetIdFromCard(card);
  
  if (!tweetId) {
    debug('No tweet ID found in card, skipping');
    markProcessed(card);
    return;
  }

  debug('Processing card with tweet ID:', tweetId);

  // ──────────────────────────────────────────────────────────────────────────────
  // STEP 2: Get tweet data from Ably (SINGLE SOURCE OF TRUTH)
  // ──────────────────────────────────────────────────────────────────────────────
  timer.mark('ablyLookup');
  const tweetData = tweetMapService.getById(tweetId);
  
  if (!tweetData) {
    debug('Tweet not found in Ably tweetMap:', tweetId);
    markProcessed(card);
    return;
  }

  debug('Found in Ably:', {
    id: tweetId,
    handle: tweetData.handle,
    type: tweetData.type,
    hasBody: !!tweetMapService.getBodyText(tweetData)
  });

  // ──────────────────────────────────────────────────────────────────────────────
  // STEP 3: Extract enriched data from Ably
  // ──────────────────────────────────────────────────────────────────────────────
  timer.mark('extractAblyData');
  
  const handle = tweetData.handle || 'unknown';
  const name = tweetData.name || handle;
  const body = tweetMapService.getBodyText(tweetData);
const tweetType = tweetMapService.getTweetType(tweetData);
const statusUrl = tweetData.url || `https://x.com/${handle}/status/${tweetId}`;
let referenceUrl = tweetMapService.getReferenceUrl(tweetData);

const needsReferenceUrl = ['quote'].includes(tweetType);

if (needsReferenceUrl && !referenceUrl) {
  debug('Waiting for reference URL for', tweetType, tweetId);
  
  // Wait for update or timeout after 200ms
  await new Promise((resolve) => {
    const timeout = setTimeout(() => {
      pendingReferenceUrls.delete(tweetId);
      debug('⚠️ Timeout waiting for reference URL:', tweetId);
      resolve();
    }, 550);
  
    pendingReferenceUrls.set(tweetId, { resolve, timeout });
  });

  
  debug('Resuming processing for:', tweetId);
  
  // ✅ RE-FETCH updated data from tweetMap
  const updatedData = tweetMapService.getById(tweetId);
  referenceUrl = tweetMapService.getReferenceUrl(updatedData);
  
  if (referenceUrl) {
    debug('✅ Reference URL found after wait:', referenceUrl);
  } else {
    debug('⚠️ Reference URL still missing after wait');
  }
}

// Extract URLs from body
const links = extractUrls(body);

  debug('Extracted:', {
    handle,
    name,
    tweetType,
    statusUrl,
    referenceUrl,
    bodyLength: body.length,
    links: links.length
  });

  // ──────────────────────────────────────────────────────────────────────────────
  // STEP 4: Set image data to empty/false (removed image extraction)
  // ──────────────────────────────────────────────────────────────────────────────
  timer.mark('noImages');
  const images = [];
  const hasImage = false;

  debug('Images disabled (always false)');

  // ──────────────────────────────────────────────────────────────────────────────
  // STEP 5: Build preview text for toast
  // ──────────────────────────────────────────────────────────────────────────────
  timer.mark('buildPreview');
  
const bodyPreview = body.length > 50 ? body.slice(0, 50) + '...' : body;

let preview = `${name} (@${handle})\n${bodyPreview}`;
if (referenceUrl) {
  preview += `\n\n→ ${referenceUrl}`;
}
  // ──────────────────────────────────────────────────────────────────────────────
  // STEP 6: Show toast notification
  // ──────────────────────────────────────────────────────────────────────────────
  timer.mark('showToast');
  
  const toast = makeToast({
    title: `${tweetType.toUpperCase()} — ${nowHHMMSS()}`,
    preview,
    onCopyText: async () => copyTextAllBrowsers(preview),
    onCopyHtml: async () => {
      const html = [
        `<div class="tweet ${tweetType}">`,
        `  <div class="tweet__head"><strong>${name}</strong><br>@${handle}</div>`,
        `  <div class="tweet__body">${body}</div>`,
        referenceUrl ? `  <div class="tweet__ref"><a href="${referenceUrl}">${referenceUrl}</a></div>` : '',
        `</div>`
      ].filter(Boolean).join('\n');
      return copyTextAllBrowsers(html);
    },
    onCopyLinks: async () => {
  // Only copy the reference URL (parent/quoted/retweeted tweet)
  if (referenceUrl) {
    return copyTextAllBrowsers(referenceUrl);
  }
  return copyTextAllBrowsers('No reference URL');
},
    onRefresh: async () => {
      // Re-fetch from Ably
      const freshData = tweetMapService.getById(tweetId);
      if (!freshData) return { text: 'Not found in Ably', html: 'Not found in Ably' };
      
      const freshBody = tweetMapService.getBodyText(freshData);
      const freshPreview = `${name} (@${handle})\n${freshBody}`;
      return { text: freshPreview, html: freshPreview };
    },
    extraButtons: referenceUrl ? [
      { label: 'Copy ref', handler: () => copyTextAllBrowsers(referenceUrl) }
    ] : []
  });

  pushToast(toast);

  // ──────────────────────────────────────────────────────────────────────────────
  // STEP 7: Record to recent toasts
  // ──────────────────────────────────────────────────────────────────────────────
  timer.mark('recordToast');
  
  window.__recordRecentToast?.({
    type: tweetType,
    name,
    handle,
    statusUrl,
    contextUrl: referenceUrl || '',
    at: Date.now(),
    preview
  });

  // ──────────────────────────────────────────────────────────────────────────────
  // STEP 8: Notify background script (unchanged contract)
  // ──────────────────────────────────────────────────────────────────────────────
  timer.mark('beforeNotifyBg');
  
  await notifyBackground({
    name,
    handle,
    text: body,
    html: card.outerHTML || '',
    statusUrl,
    tweetType,
    contextUrl: referenceUrl || '',
    links,
    images,
    hasImage,
    // Type-specific URLs for backwards compatibility
    retweetedUrl: tweetType === 'retweet' ? referenceUrl : undefined,
    quoteUrl: tweetType === 'quote' ? referenceUrl : undefined
  });

  timer.mark('afterNotifyBg');
  timer.report('complete');
  cardTimers.delete(card);

  markProcessed(card);
  debug('✅ Card processed successfully:', tweetId);
}

// ═══════════════════════════════════════════════════════════════════════════════
// SECTION 11: DOM OBSERVER
// ═══════════════════════════════════════════════════════════════════════════════

const observer = new MutationObserver((mutations) => {
  for (const mutation of mutations) {
    for (const node of mutation.addedNodes) {
      if (!(node instanceof Element)) continue;

      // Check if this node matches our selector
      if (node.matches?.(CONFIG.CARD_SELECTOR)) {
        debug('Card detected (root):', node.dataset.uxTweetId || 'unknown');
        processCard(node);
      }

      // Check nested cards
      const nestedCards = node.querySelectorAll?.(CONFIG.CARD_SELECTOR) || [];
      nestedCards.forEach(card => {
        debug('Card detected (nested):', card.dataset.uxTweetId || 'unknown');
        processCard(card);
      });
    }
  }
});

observer.observe(document.documentElement, {
  childList: true,
  subtree: true
});

// Initial scan for existing cards
debug('Starting initial card scan...');
const existingCards = document.querySelectorAll(CONFIG.CARD_SELECTOR);
existingCards.forEach(card => {
  debug('Card detected (initial):', card.dataset.uxTweetId || 'unknown');
  processCard(card);
});

debug('Uxento v2 initialized!');
debug('TweetMap stats:', tweetMapService.getStats());

// ═══════════════════════════════════════════════════════════════════════════════
// SECTION 12: BRIDGE LISTENER (for popup/devtools)
// ═══════════════════════════════════════════════════════════════════════════════

window.addEventListener('message', (event) => {
  if (event.source !== window) return;
  
  const msg = event.data;
  if (!msg || msg.type !== 'BRIDGE_TO_UXENTO') return;

  const payload = msg.payload;

  if (payload.type === 'get_latest_toasts') {
    const n = Math.max(1, Math.min(Number(payload.limit) || 10, 40));
    const items = (window.__uxentoRecentToasts || []).slice(-n).reverse();
    
    window.postMessage({
      type: 'UXENTO_RESPONSE',
      payload: { ok: true, items }
    }, '*');
  }

  if (payload.type === 'get_tweetmap_stats') {
    window.postMessage({
      type: 'UXENTO_RESPONSE',
      payload: { ok: true, stats: tweetMapService.getStats() }
    }, '*');
  }
});

})();