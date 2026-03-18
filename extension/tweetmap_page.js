// tweetmap_page.js
// Runs in the PAGE's main world (world: "MAIN").
// Hooks fetch/XHR and ALSO Ably "CT_Tracker5 decrypted" console logs
// to build window.__uxentoTweetMap + window.__uxentoTweetMapDebug.

/* eslint-disable no-undef */

(() => {
  const DEBUG_TRACE = true;

  // We'll capture original console methods BEFORE we hook them
  const origConsoleDebug = console.debug ? console.debug.bind(console) : (..._args) => {};
  const origConsoleLog = console.log ? console.log.bind(console) : (..._args) => {};

  function dbg(...args) {
    if (!DEBUG_TRACE) return;
    try {
      origConsoleDebug('[uxento-tweet-map][page]', ...args);
    } catch (_) {}
  }

  function warn(...args) {
    try {
      origConsoleLog('[uxento-tweet-map][page]', ...args);
    } catch (_) {}
  }

  try {
    if (window.__UXENTO_TWEET_MAP_HOOKED__) {
      dbg('hook already installed, skipping');
      return;
    }
    window.__UXENTO_TWEET_MAP_HOOKED__ = true;
  } catch (_) {
    return;
  }

  dbg('hook install starting (MAIN world)');

  // Debug state you can inspect from DevTools
  const debugState = {
    installs: 1,
    fetchHooks: 0,
    xhrHooks: 0,
    fetchIntercepts: 0,
    xhrIntercepts: 0,
    jsonParseErrors: 0,
    nonJsonResponses: 0,
    scanCalls: 0,
    tweetObjectsFound: 0,
    ablyIntercepts: 0,
    lastErrors: []
  };
  window.__uxentoTweetMapDebug = debugState;

  // Global tweet map: id -> { id, url, handle, name, body, created_at, sourceUrl, type, ... }
  const tweetMap = {};
  window.__uxentoTweetMap = tweetMap;

  // ---- Tweet shape detection ----

  function isStandardTweet(obj) {
    if (!obj || typeof obj !== 'object') return false;

    const hasId =
      Object.prototype.hasOwnProperty.call(obj, 'id_str') ||
      Object.prototype.hasOwnProperty.call(obj, 'id');
    const hasUser =
      !!(obj.user && typeof obj.user.screen_name === 'string');
    const hasText =
      Object.prototype.hasOwnProperty.call(obj, 'full_text') ||
      Object.prototype.hasOwnProperty.call(obj, 'text');

    return hasId && hasUser && hasText;
  }

  function isTrackerTweet(obj) {
    if (!obj || typeof obj !== 'object') return false;

    const t = (obj.type || '').toUpperCase();
    const allowed = ['TWEET', 'QUOTE_TWEET', 'QUOTE', 'REPLY', 'RETWEET'];

    if (!allowed.includes(t)) {
      return false;
    }

    const author = obj.author || obj.user || {};
    const handle =
      author.screen_name ||
      author.username ||
      author.handle ||
      author.name ||
      null;
    const body = obj.body || {};
    const hasText = !!(body.rawText || body.text || body.full_text);
    const hasId = !!(obj.id || obj.primaryId || obj.tweetId || obj.tweet_id);
    return !!(handle && hasText && hasId);
  }

  function isTweetLike(obj) {
    return isStandardTweet(obj) || isTrackerTweet(obj);
  }

  function extractHandleFromTracker(obj) {
    const author = obj.author || obj.user || {};
    return (
      author.screen_name ||
      author.username ||
      author.handle ||
      author.name ||
      null
    );
  }

  function extractNameFromTracker(obj) {
    const author = obj.author || obj.user || {};
    return (
      author.name ||
      author.display_name ||
      author.displayName ||
      null
    );
  }

  function extractIdFromAnyTweet(obj) {
    if (!obj || typeof obj !== 'object') return null;
    if (obj.id_str !== undefined) return String(obj.id_str).trim();
    if (obj.id !== undefined) return String(obj.id).trim();
    if (obj.primaryId !== undefined) return String(obj.primaryId).trim();
    if (obj.tweetId !== undefined) return String(obj.tweetId).trim();
    if (obj.tweet_id !== undefined) return String(obj.tweet_id).trim();
    return null;
  }

  function canonicalTweetUrlFromObj(t) {
    try {
      // Standard tweet shape
      if (isStandardTweet(t)) {
        const rawId =
          (t && (t.id_str !== undefined ? t.id_str : t.id)) || '';
        const id = String(rawId).trim();
        const handle =
          t &&
          t.user &&
          t.user.screen_name
            ? String(t.user.screen_name).trim()
            : '';
        if (!id || !handle) return null;
        return 'https://x.com/' + handle + '/status/' + id;
      }

      // Tracker/Ably tweet shape
      if (isTrackerTweet(t)) {
        const id = extractIdFromAnyTweet(t);
        const handle = extractHandleFromTracker(t);
        if (!id || !handle) return null;
        return 'https://x.com/' + handle + '/status/' + id;
      }

      return null;
    } catch (e) {
      debugState.lastErrors.push({
        where: 'canonicalTweetUrlFromObj',
        error: String(e)
      });
      return null;
    }
  }

  function scanForTweets(data, srcUrl) {
    debugState.scanCalls++;
    const seenUrls = [];
    let localCount = 0;

    function walk(node, depth) {
      if (!node) return;
      if (depth > 7) return; // avoid insane nesting

      if (Array.isArray(node)) {
        for (const item of node) {
          walk(item, depth + 1);
        }
        return;
      }

      if (typeof node !== 'object') {
        return;
      }

      if (isTweetLike(node)) {
        const url = canonicalTweetUrlFromObj(node);
        if (url) {
          const rawId = extractIdFromAnyTweet(node);
          const id = String(rawId || url);

          // Create or reuse entry
          let entry = tweetMap[id];
          if (!entry) {
            entry = tweetMap[id] = {
              id,
              url,
              handle: extractHandleFromTracker(node) ||
                (node.user && node.user.screen_name
                  ? String(node.user.screen_name)
                  : null),
              name: extractNameFromTracker(node) ||
                (node.user && node.user.name
                  ? String(node.user.name)
                  : null),
              body: node.body || null,
              created_at: node.created_at || node.timestamp || null,
              sourceUrl: srcUrl || null,
              type: node.type || null
            };
            seenUrls.push(url);
            localCount++;
          } else {
            // Update existing entry with body/name if missing
            entry.type = entry.type || node.type || null;
            if (!entry.sourceUrl && srcUrl) entry.sourceUrl = srcUrl;
            if (!entry.body && node.body) entry.body = node.body;
            if (!entry.name && extractNameFromTracker(node)) {
              entry.name = extractNameFromTracker(node);
            }
          }

          // Keep raw CT relations for getReferenceUrlFromTweetMap
          if (node.reply && !entry.reply) entry.reply = node.reply;
          if (node.quote && !entry.quote) entry.quote = node.quote;
          if (node.context && !entry.context) entry.context = node.context;

          // ---- Enrich relationships ----
          try {
            // ✅ FIX: Determine actual type - prioritize reply/retweet presence over declared type
            let tType = (node.type || '').toUpperCase();
            
            // If tweet has a reply field, it's a REPLY (even if type says QUOTE)
            if (node.reply && node.reply.id) {
              tType = 'REPLY';
              // Update entry type to match reality
              if (entry.type !== 'REPLY') entry.type = 'REPLY';
            }

            // ---- Enrich: REPLY → parent refId + refUrl ----
            if (tType === 'REPLY') {
              const reply   = node.reply || {};
              const ctxSub  = (node.context && node.context.subtweet) || {};

              const parentIdRaw =
                reply.id ||
                ctxSub.id ||
                reply.tweet_id ||
                reply.tweetId ||
                null;

              if (parentIdRaw) {
                const parentId = String(parentIdRaw).trim();
                entry.refId = parentId;
                
                // Use /i/web/status/ format (no handle needed)
                entry.refUrl = `https://x.com/i/web/status/${parentId}`;
                  window.postMessage({
    type: 'TWEETMAP_UPDATED',
    tweetId: entry.id,
    hasReferenceUrl: true
  }, '*');
                
                // Create synthetic parent entry if needed
                if (entry.refId && !tweetMap[entry.refId]) {
                  tweetMap[entry.refId] = {
                    id: entry.refId,
                    url: entry.refUrl,
                    type: 'TWEET',
                    sourceUrl: srcUrl,
                    synthetic: true
                  };
                  dbg('[tweetmap] synthetic parent entry created', entry.refId);
                }
              }
            }

           
          // ---- Enrich: QUOTE → quotedId + quotedUrl ----
// Note: Replies can ALSO have quotes (quote replies), so process both
if (tType === 'QUOTE_TWEET' || tType === 'QUOTE' || (node.quoted && node.quoted.id)) {
  const quote   = node.quote || node.quoted || node.subtweet || {};
  const ctxQ    = (node.context && node.context.quote) || {};

  const quoteIdRaw = quote.id || ctxQ.id || null;
  if (quoteIdRaw) {
    const quoteId = String(quoteIdRaw).trim();
    entry.quotedId = quoteId;
    
    // Standardized format - no handle needed
    entry.quotedUrl = `https://x.com/i/web/status/${quoteId}`;
    window.postMessage({
      type: 'TWEETMAP_UPDATED',
      tweetId: entry.id,
      hasReferenceUrl: true
    }, '*');
  }
}

// ---- Enrich: RETWEET → retweetedId + retweetedUrl ----
if (tType === 'RETWEET') {
  const rt = node.retweet || node.target || node.subtweet || {};
  const rtIdRaw = rt.id || rt.tweet_id || rt.tweetId || null;
  if (rtIdRaw) {
    const rtId = String(rtIdRaw).trim();
    entry.retweetedId = rtId;

    // Create/update the retweeted tweet entry
    if (!tweetMap[rtId]) {
      tweetMap[rtId] = {
        id: rtId,
        url: null,
        type: rt.type || 'TWEET',
        sourceUrl: srcUrl,
        synthetic: true
      };
    }
    
    // Store reverse mapping (original tweet → retweet)
    if (!tweetMap[rtId].retweetedBy) {
      tweetMap[rtId].retweetedBy = [];
    }
    tweetMap[rtId].retweetedBy.push({
      id: entry.id,
      handle: entry.handle,
      url: entry.url,
      timestamp: entry.created_at || Date.now()
    });
    dbg('[tweetmap] recorded retweetedBy', rtId, '→', entry.id);

    // Standardized format - no handle needed
    entry.retweetedUrl = `https://x.com/i/web/status/${rtId}`;
    window.postMessage({
      type: 'TWEETMAP_UPDATED',
      tweetId: entry.id,
      hasReferenceUrl: true
    }, '*');
  }
}
          } catch (e) {
            debugState.lastErrors.push({
              where: 'scanForTweets.enrichRelations',
              error: String(e),
              srcUrl: srcUrl || null
            });
          }
        }
      }

      for (const key in node) {
        if (!Object.prototype.hasOwnProperty.call(node, key)) continue;
        const value = node[key];
        if (value && typeof value === 'object') {
          walk(value, depth + 1);
        }
      }
    }

    try {
      walk(data, 0);
    } catch (e) {
      debugState.lastErrors.push({
        where: 'scanForTweets.walk',
        error: String(e),
        srcUrl: srcUrl || null
      });
    }

    debugState.tweetObjectsFound += localCount;

    if (localCount > 0) {
      dbg('scanForTweets found', localCount, 'tweets from', srcUrl, seenUrls);
    } else {
      dbg('scanForTweets found 0 tweets from', srcUrl);
    }
  }

  // ---- Hook fetch ----
  if (typeof window.fetch === 'function') {
    debugState.fetchHooks++;
    const origFetch = window.fetch.bind(window);

    window.fetch = async function (...args) {
      debugState.fetchIntercepts++;

      let reqUrl = null;
      try {
        const req = args[0];
        reqUrl = (req && req.url) || req || null;
      } catch (_) {}

      dbg('fetch intercept', { url: reqUrl });

      const res = await origFetch(...args);

      try {
        const clone = res.clone();
        clone
          .json()
          .then((data) => {
            dbg('fetch JSON parsed ok for', reqUrl);
            scanForTweets(data, reqUrl);
          })
          .catch((e) => {
            debugState.jsonParseErrors++;
            debugState.lastErrors.push({
              where: 'fetch.clone.json',
              error: String(e),
              url: reqUrl
            });
            dbg('fetch JSON parse failed for', reqUrl, e);
          });
      } catch (e) {
        debugState.nonJsonResponses++;
        debugState.lastErrors.push({
          where: 'fetch.clone',
          error: String(e),
          url: reqUrl
        });
        dbg('fetch clone/json not attempted for', reqUrl, e);
      }

      return res;
    };

    dbg('fetch hook installed');
  } else {
    warn('window.fetch not present; only XHR will be hooked');
  }

  // ---- Hook XMLHttpRequest ----
  (function hookXHR() {
    const OrigXHR = window.XMLHttpRequest;
    if (!OrigXHR) {
      warn('XMLHttpRequest not present; XHR hook skipped');
      return;
    }

    debugState.xhrHooks++;

    function WrappedXHR() {
      const xhr = new OrigXHR();
      let url = null;

      const origOpen = xhr.open;
      xhr.open = function (method, u, ...rest) {
        url = u;
        dbg('XHR open', { method, url });
        return origOpen.call(xhr, method, u, ...rest);
      };

      xhr.addEventListener('load', function () {
        debugState.xhrIntercepts++;
        try {
          const contentType = xhr.getResponseHeader('content-type') || '';
          if (!/application\/json/i.test(contentType)) {
            debugState.nonJsonResponses++;
            dbg('XHR non-JSON response, content-type =', contentType, 'url =', url);
            return;
          }
          const text = xhr.responseText;
          if (!text) {
            dbg('XHR empty JSON body for', url);
            return;
          }

          let data = null;
          try {
            data = JSON.parse(text);
          } catch (e) {
            debugState.jsonParseErrors++;
            debugState.lastErrors.push({
              where: 'XHR.JSON.parse',
              error: String(e),
              url: url
            });
            dbg('XHR JSON parse failed for', url, e);
            return;
          }

          dbg('XHR JSON parsed ok for', url);
          scanForTweets(data, url);
        } catch (e) {
          debugState.lastErrors.push({
            where: 'XHR.load.handler',
            error: String(e),
            url: url
          });
          warn('XHR load handler error for', url, e);
        }
      });

      return xhr;
    }

    window.XMLHttpRequest = WrappedXHR;
    dbg('XHR hook installed');
  })();

  // ---- Hook console for Ably "CT_Tracker5 decrypted" ----
// ---- Hook console for Ably + NotiSound (NEW) ----
function interceptConsole(methodName, origFn) {
  return function (...args) {
    try {
      const label = args[0];
      const payload = args[1];

      if (typeof label === 'string') {

        // 🔹 OLD: direct Ably decrypted logs
        if (
          label.includes('[Ably]') &&
          label.includes('CT_Tracker5') &&
          label.includes('decrypted')
        ) {
          debugState.ablyIntercepts++;
          dbg('Ably decrypted intercept', { label, payload });
          scanForTweets(payload, 'ably:CT_Tracker5');
        }

        // 🔹 NEW: NotiSound pipeline (THIS IS YOUR FIX)
        if (
          label.includes('[NotiSound] playNotification called') &&
          label.includes('source: CT_Tracker5')
        ) {
          debugState.ablyIntercepts++;
          dbg('NotiSound CT_Tracker5 intercept', { payload });
          scanForTweets(payload, 'notisound:CT_Tracker5');
        }

        // 🔹 OPTIONAL: catch AI-DBG too (extra safety)
        if (
          label.includes('[AI-DBG]') &&
          payload &&
          typeof payload === 'object'
        ) {
          debugState.ablyIntercepts++;
          dbg('AI-DBG intercept', { payload });
          scanForTweets(payload, 'aidbg');
        }
      }

    } catch (e) {
      debugState.lastErrors.push({
        where: 'console.' + methodName,
        error: String(e)
      });
    }

    return origFn(...args);
  };
}

console.debug = interceptConsole('debug', origConsoleDebug);
console.log = interceptConsole('log', origConsoleLog);
  dbg('hook install finished; tweetMap + debug state exposed on window');
})();