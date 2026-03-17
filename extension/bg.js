// bg.js — service worker for rules, orders, and buy execution
// OPTIMIZED VERSION - parallel processing, batched storage, cached normalizations
// WITH PERFORMANCE TIMING SYSTEM

// ⚡ PRODUCTION MODE: Set to true to disable ALL logging and save ~10-20ms per snipe
const PRODUCTION_MODE = true;  // Set to true for production (disables all logs)

// ⚡ VERBOSE TIMING: Set to false to disable detailed timing logs (but keep critical logs)
const VERBOSE_TIMING = true;  // Set to false to disable timing logs

// Logging functions with zero overhead in production mode
// These are still evaluated (argument processing), but do nothing
const LOG = PRODUCTION_MODE ? () => {} : (msg, ...rest) => console.log("[MemebuyUnified/bg]", msg, ...rest);
const LOG_TIMING = (PRODUCTION_MODE || !VERBOSE_TIMING) ? () => {} : LOG;

// Critical logs that always output (errors, successful trades, etc)
const CRITICAL_LOG = (msg, ...rest) => console.log("[MemebuyUnified/bg]", msg, ...rest);

// Conditional execution macros for expensive logging operations
// These completely skip code execution in production mode
const IF_DEBUG = (fn) => { if (!PRODUCTION_MODE) fn(); };
const IF_TIMING = (fn) => { if (!PRODUCTION_MODE && VERBOSE_TIMING) fn(); };

// ════════════════════════════════════════════════════════════════
// 🚀 ORDER CACHE - Eliminates 17ms storage read per tweet
// ════════════════════════════════════════════════════════════════
let ordersCache = null;
let ordersCacheTime = 0;

function safeSendToPopup(payload) {
  try {
    chrome.runtime.sendMessage(payload).catch(() => {
      // no popup / no listener -> ignore
    }); 
  } catch (_e) {
    // older Chrome might not have .catch on sendMessage promise,
    // or sendMessage might not return a promise in MV3 service worker rescope.
    // We swallow because it's non-fatal.
  }
}

// ════════════════════════════════════════════════════════════════
// 🔥 JSON PARSING WARMUP - Eliminates cold start penalty
// ════════════════════════════════════════════════════════════════

/**
 * Warm up V8's JSON.parse to eliminate first-call penalty (~40-50ms)
 * This is critical for first snipe performance
 */
async function warmupJsonParsing() {
  try {
    const start = performance.now();
    
    // Create realistic dummy signer responses of various sizes
    const dummyResponses = [
      // Small response
      { 
        ok: true, 
        hash: '0x' + '0'.repeat(64), 
        elapsedMs: 50 
      },
      // Medium response
      { 
        ok: true, 
        hash: '0x' + 'a'.repeat(64), 
        elapsedMs: 50, 
        mode: 'broadcast-only', 
        rpcUsed: 1,
        gasPriceGwei: 3,
        gasLimit: 500000
      },
      // Large response with full timing details (most realistic)
      { 
        ok: true, 
        hash: '0x' + 'b'.repeat(64), 
        elapsedMs: 52,
        timing: {
          t0_request_received: 1000.0,
          t1_body_parsed: 1000.1,
          t2_gas_retrieved: 1008.5,
          t3_nonce_retrieved: 1008.6,
          t4_tx_built: 1008.7,
          t5_tx_signed: 1016.3,
          t6_rpc_started: 1016.4,
          t7_rpc_completed: 1042.8,
          t8_response_ready: 1042.9
        },
        mode: 'broadcast-only',
        rpcUsed: 1,
        gasPriceGwei: 3.0,
        gasLimit: 500000,
        route: 'pancake'
      },
      // Solana response format
      {
        ok: true,
        sig: 'abc123' + 'x'.repeat(80),
        signature: 'abc123' + 'x'.repeat(80),
        hash: 'abc123' + 'x'.repeat(80),
        mode: 'pumpportal',
        elapsedMs: 45,
        timing: {
          totalMs: 45,
          pumpRequestMs: 42
        }
      }
    ];
    
    // Warm up JSON.parse by parsing these dummy responses multiple times
    for (const dummy of dummyResponses) {
      const json = JSON.stringify(dummy);
      // Parse 3 times to fully warm up
      JSON.parse(json);
      JSON.parse(json);
      JSON.parse(json);
    }
    
    // Also warm up with various common JSON structures
    JSON.parse('{"ok":true}');
    JSON.parse('{"ok":false,"error":"test"}');
    JSON.parse('[]');
    JSON.parse('{}');
    
    const elapsed = performance.now() - start;
    LOG(`🔥 JSON.parse warmed up in ${elapsed.toFixed(1)}ms`);
  } catch (e) {
    LOG('⚠️ JSON warmup failed (non-critical):', e.message);
  }
}

/**
 * Warm up fetch calls to signer to eliminate first-request penalty
 * This is the "pure fetch test" moved to startup instead of per-order
 */
async function warmupFetchToSigner() {
  try {
    LOG('🔥 Warming up fetch to signer...');
    const start = performance.now();
    
    // Make a dummy request to warm up the connection
    const testResponse = await fetch('http://127.0.0.1:8787/swap', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ 
        token: '0x0000000000000000000000000000000000000000', 
        amountBNB: 0.001, 
        dryRun: true 
      })
    });
    await testResponse.json();
    
    const elapsed = performance.now() - start;
    LOG(`🔥 Fetch to signer warmed in ${elapsed.toFixed(1)}ms`);
  } catch (e) {
    LOG('⚠️ Signer fetch warmup failed (non-critical):', e.message);
  }
}

// Run warmup when service worker starts
warmupJsonParsing().catch(e => LOG('JSON warmup error:', e));
warmupFetchToSigner().catch(e => LOG('Fetch warmup error:', e));

// ═══════════════════════════════════════════════════════════════
// 💧 SLIPPAGE PROTECTION - Get Expected Tokens from PancakeSwap
// ═══════════════════════════════════════════════════════════════

/**
 * Get expected tokens out from PancakeSwap router for slippage calculation
 * Only used when slippage is explicitly set for BNB buys
 * @param {string} tokenAddress - Token contract address
 * @param {number} amountBNB - Amount of BNB to spend
 * @returns {Promise<string|null>} Expected tokens as string, or null on error
 */
// ═══════════════════════════════════════════════════════════════
// 🚀 WebSocket Client for Ultra-Low Latency (~2-3ms vs ~18ms HTTP)
// ═══════════════════════════════════════════════════════════════

class SignerWebSocket {
  constructor(url = 'ws://127.0.0.1:8788') {
    this.url = url;
    this.ws = null;
    this.pendingRequests = new Map();
    this.requestId = 0;
    this.isConnected = false;
    this.reconnectAttempts = 0;
    this.maxReconnectAttempts = 10;
    this.everConnected = false;  // Track if we ever successfully connected
    this.pingInterval = null;  // Keepalive ping interval
    this.lastPong = Date.now();  // Track last pong response
    this.pongTimeout = null;  // Timeout for pong response
    
    LOG(`🔌 Initializing WebSocket connection to ${url}`);
    this.connect();
  }
  
  connect() {
    try {
      this.ws = new WebSocket(this.url);
      
      this.ws.onopen = () => {
        this.isConnected = true;
        this.everConnected = true;
        this.reconnectAttempts = 0;
        this.lastPong = Date.now();
        LOG('🔌 ✅ WebSocket connected to signer');
        
        // Start keepalive pings to prevent idle disconnection
        this.startPing();
      };
      
      this.ws.onmessage = (event) => {
        try {
          const response = JSON.parse(event.data);
          
          // Handle pong response (keepalive)
          if (response.type === 'pong') {
            this.lastPong = Date.now();
            if (this.pongTimeout) {
              clearTimeout(this.pongTimeout);
              this.pongTimeout = null;
            }
            return;
          }
          
          const request = this.pendingRequests.get(response.id);
          
          if (request) {
            // Attach timing data to response before resolving
            response._requestTiming = request.timing;
            request.resolve(response);
            this.pendingRequests.delete(response.id);
          }
        } catch (e) {
          LOG('⚠️ WebSocket parse error:', e.message);
        }
      };
      
      this.ws.onclose = () => {
        this.isConnected = false;
        
        // Stop keepalive pings
        this.stopPing();
        
        // Only log disconnection if we were previously connected
        if (this.everConnected) {
          LOG('🔌 ❌ WebSocket disconnected');
        }
        
        // Auto-reconnect with exponential backoff
        if (this.reconnectAttempts < this.maxReconnectAttempts) {
          const delay = Math.min(1000 * Math.pow(2, this.reconnectAttempts), 30000);
          this.reconnectAttempts++;
          
          // Only log reconnection attempts if we were previously connected
          if (this.everConnected) {
            LOG(`🔌 Reconnecting in ${delay}ms (attempt ${this.reconnectAttempts}/${this.maxReconnectAttempts})...`);
          }
          
          setTimeout(() => this.connect(), delay);
        } else {
          // Only log max attempts if we were previously connected (otherwise it's just not available)
          if (this.everConnected) {
            LOG('🔌 ❌ Max reconnect attempts reached. Falling back to HTTP.');
          }
        }
      };
      
      this.ws.onerror = (err) => {
        // Only log errors if we were previously connected (otherwise it's just unavailable)
        if (this.everConnected) {
          LOG('🔌 ❌ WebSocket error:', err.message);
        }
      };
      
    } catch (e) {
      LOG('🔌 ❌ Failed to create WebSocket:', e.message);
    }
  }
  
  startPing() {
    // Stop any existing ping interval
    this.stopPing();
    
    // Send ping every 30 seconds to keep connection alive
    this.pingInterval = setInterval(() => {
      if (this.isConnected && this.ws && this.ws.readyState === WebSocket.OPEN) {
        const id = ++this.requestId;
        
        try {
          this.ws.send(JSON.stringify({ 
            id, 
            type: 'ping', 
            timestamp: Date.now() 
          }));
          
          // Set a timeout to detect if pong never comes back (5 seconds)
          this.pongTimeout = setTimeout(() => {
            LOG('🔌 ⚠️ No pong received, connection may be dead');
            // Close and reconnect
            if (this.ws) {
              this.ws.close();
            }
          }, 5000);
          
        } catch (e) {
          LOG('🔌 ⚠️ Failed to send ping:', e.message);
        }
      }
    }, 30000); // Ping every 30 seconds
    
    LOG('🔌 💓 Keepalive pings started (30s interval)');
  }
  
  stopPing() {
    if (this.pingInterval) {
      clearInterval(this.pingInterval);
      this.pingInterval = null;
    }
    if (this.pongTimeout) {
      clearTimeout(this.pongTimeout);
      this.pongTimeout = null;
    }
  }
  
  async swap(payload, chain = 'bnb') {
    // Check if WebSocket is available
    if (!this.isConnected || !this.ws || this.ws.readyState !== WebSocket.OPEN) {
      LOG('⚠️ WebSocket not available, falling back to HTTP');
      throw new Error('WebSocket not connected');
    }
    
    const id = ++this.requestId;
    
    // ⏱️ T0: Start timing
    const t0 = performance.now();
    
    return new Promise((resolve, reject) => {
      // Prepare message object
      const message = {
        id,
        type: chain === 'sol' ? 'swapSol' : 'swap',
        payload
      };
      
      // ⏱️ T1: Stringify request
      const t1 = performance.now();
      const messageStr = JSON.stringify(message);
      const t2 = performance.now();
      
      // ⏱️ T3: Send via WebSocket
      this.ws.send(messageStr);
      const t3 = performance.now();
      
      // Store the pending request with timing data
      this.pendingRequests.set(id, { 
        resolve, 
        reject, 
        timing: {
          t0_start: t0,
          t1_stringify_start: t1,
          t2_stringify_done: t2,
          t3_send_done: t3
        }
      });
      
      // Timeout after 10s
      setTimeout(() => {
        if (this.pendingRequests.has(id)) {
          this.pendingRequests.delete(id);
          reject(new Error('WebSocket request timeout'));
        }
      }, 10000);
    }).then(response => {
      // ⏱️ T4: Response received (in .then handler)
      const t4 = performance.now();
      
      // Get the timing data that was attached in onmessage
      const timing = response._requestTiming;
      if (!timing) {
        // Fallback to simple calculation if timing data missing
        const totalMs = t4 - t0;
        const signerMs = response.elapsedMs || 0;
        const networkMs = totalMs - signerMs;
        
        response.networkMs = Math.round(networkMs);
        response.totalMs = Math.round(totalMs);
        return response;
      }
      
      const totalMs = t4 - timing.t0_start;
      const signerMs = response.elapsedMs || 0;
      const networkMs = totalMs - signerMs;
      
      // Calculate detailed breakdown
      const prepareMs = timing.t2_stringify_done - timing.t0_start;
      const sendMs = timing.t3_send_done - timing.t2_stringify_done;
      const waitMs = t4 - timing.t3_send_done - signerMs;
      
      // Add detailed timing to response
      response.networkMs = Math.round(networkMs);
      response.totalMs = Math.round(totalMs);
      response.networkBreakdown = {
        prepare: Number(prepareMs.toFixed(2)),    // JSON.stringify time
        send: Number(sendMs.toFixed(2)),          // ws.send() time
        wait: Number(waitMs.toFixed(2)),          // Network round-trip wait
        signer: signerMs                          // Signer processing time
      };
      
      
      return response;
    });
  }
  
  ping() {
    return new Promise((resolve) => {
      if (!this.isConnected) {
        resolve(false);
        return;
      }
      
      const id = ++this.requestId;
      const t0 = performance.now();
      
      this.pendingRequests.set(id, { 
        resolve: (response) => {
          const latency = performance.now() - t0;
          resolve({ ok: true, latency });
        },
        reject: () => resolve({ ok: false })
      });
      
      this.ws.send(JSON.stringify({ id, type: 'ping' }));
      
      setTimeout(() => {
        if (this.pendingRequests.has(id)) {
          this.pendingRequests.delete(id);
          resolve({ ok: false });
        }
      }, 1000);
    });
  }
}

// Initialize WebSocket clients on service worker start
const signerWS = new SignerWebSocket('ws://127.0.0.1:8788');  // Wallet 1 (required)

// Wallet 2 WebSocket - optional, reduced reconnection attempts
const signerWS2 = new SignerWebSocket('ws://127.0.0.1:8790');
signerWS2.maxReconnectAttempts = 2; // Only try twice, then give up silently

// Track if Wallet 2 is available
let wallet2Available = false;

// Test WebSocket connections after 2 seconds
setTimeout(async () => {
  // Test Wallet 1 WebSocket (required)
  const result = await signerWS.ping();
  if (result.ok) {
    LOG(`🔌 Wallet 1 WebSocket ping: ${result.latency.toFixed(1)}ms`);
  } else {
    LOG('🔌 ⚠️ Wallet 1 WebSocket ping failed - will use HTTP fallback');
  }
  
  // Test Wallet 2 WebSocket (optional)
  const result2 = await signerWS2.ping();
  if (result2.ok) {
    wallet2Available = true;
    LOG(`🔌 Wallet 2 WebSocket ping: ${result2.latency.toFixed(1)}ms`);
  } else {
    wallet2Available = false;
    LOG('🔌 💡 Wallet 2 WebSocket not available (optional) - multi-buy will use HTTP for Wallet 2');
  }
}, 2000);

// -------- Storage helpers --------
const SKEY = {
  SETTINGS: 'settings',   // signer config etc.
  ORDERS: 'orders',       // array of sniper rules
  SEEN: 'seen'            // de-dupe map: { key: timestamp }
};

async function getSettings() {
  const { [SKEY.SETTINGS]: s } = await chrome.storage.local.get(SKEY.SETTINGS);
  return s || {
    // default signer endpoint points at /swap (BNB buy)
    // we'll dynamically hit /swapSol for Solana in manual buys
    signerUrl: "http://127.0.0.1:8787/swap",
    apiToken: "",
    apiToken2: "",
    defaultGasGwei: 3
  };
}

async function setSettings(patch) {
  const cur = await getSettings();
  const nxt = { ...cur, ...patch };
  await chrome.storage.local.set({ [SKEY.SETTINGS]: nxt });
  return nxt;
}

async function getOrders() {
  // Return cached orders if available
  if (ordersCache !== null) {
    return ordersCache;
  }
  
  // Cache miss - load from storage
  const t0 = performance.now();
  const { [SKEY.ORDERS]: o } = await chrome.storage.local.get(SKEY.ORDERS);
  const orders = Array.isArray(o) ? o : [];
  
  // Store in cache
  ordersCache = orders;
  ordersCacheTime = Date.now();
  
  const elapsed = performance.now() - t0;
  
  return orders;
}

async function setOrders(arr) {
  await chrome.storage.local.set({ [SKEY.ORDERS]: arr });
  
  // Update cache immediately with new value
  ordersCache = arr;
  ordersCacheTime = Date.now();
  
  return arr;
}

async function getSeen() {
  const { [SKEY.SEEN]: m } = await chrome.storage.local.get(SKEY.SEEN);
  return m || {};
}

async function setSeen(m) {
  await chrome.storage.local.set({ [SKEY.SEEN]: m });
}

// ════════════════════════════════════════════════════════════════
// 🔄 CACHE SYNC - Keep cache in sync with storage changes
// ════════════════════════════════════════════════════════════════

/**
 * Listen for storage changes and update cache immediately
 * This keeps cache hot whether changes come from bg.js or popup
 */
chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName === 'local' && changes[SKEY.ORDERS]) {
    // Update cache with new value instead of invalidating
    ordersCache = changes[SKEY.ORDERS].newValue;
    ordersCacheTime = Date.now();
  }
});

// ════════════════════════════════════════════════════════════════
// 🆕 NEW: TIMING LOG TO SERVER
// ════════════════════════════════════════════════════════════════

/**
 * Send completed timing event to local signer server for persistent logging
 * This allows viewing logs without having extension popup open
 */
function extractSignerTimingDetails(timing) {
  if (!timing) return null;
  
  if (timing.t0_request_received !== undefined) {
    return {
      parseMs: timing.t1_body_parsed ? (timing.t1_body_parsed - timing.t0_request_received) : undefined,
      getGasMs: (timing.t2_gas_retrieved && timing.t1_body_parsed) ? (timing.t2_gas_retrieved - timing.t1_body_parsed) : undefined,
      getNonceMs: (timing.t3_nonce_retrieved && timing.t2_gas_retrieved) ? (timing.t3_nonce_retrieved - timing.t2_gas_retrieved) : undefined,
      buildTxMs: (timing.t4_tx_built && timing.t3_nonce_retrieved) ? (timing.t4_tx_built - timing.t3_nonce_retrieved) : undefined,
      signTxMs: (timing.t5_tx_signed && timing.t4_tx_built) ? (timing.t5_tx_signed - timing.t4_tx_built) : undefined,
      rpcStartMs: (timing.t6_rpc_started && timing.t5_tx_signed) ? (timing.t6_rpc_started - timing.t5_tx_signed) : undefined,
      rpcProcessMs: (timing.t7_rpc_completed && timing.t6_rpc_started) ? (timing.t7_rpc_completed - timing.t6_rpc_started) : undefined,
      buildResponseMs: (timing.t8_response_ready && timing.t7_rpc_completed) ? (timing.t8_response_ready - timing.t7_rpc_completed) : undefined,
      totalMs: timing.t8_response_ready ? (timing.t8_response_ready - timing.t0_request_received) : undefined
    };
  }
  
  if (timing.totalMs !== undefined || timing.requestMs !== undefined) {
    return {
      parseMs: timing.parseMs,
      buildFormMs: timing.buildFormMs,
      requestMs: timing.requestMs,
      jsonParseMs: timing.jsonParseMs,
      totalMs: timing.totalMs
    };
  }
  
  return null;
}


async function logTimingToServer(timingEvent) {
  try {
    const settings = await getSettings();
    const signerUrl = settings?.signerUrl || 'http://127.0.0.1:8787/swap';
    
    // Extract base URL (remove /swap or /swapSol path)
    let baseUrl;
    try {
      const url = new URL(signerUrl);
      baseUrl = `${url.protocol}//${url.host}`;
    } catch {
      baseUrl = signerUrl.replace(/\/(swap|swapSol).*/i, '');
    }
    
    // Send to timing log endpoint
    const logUrl = `${baseUrl}/api/timing-log`;
    
    await fetch(logUrl, {
      method: 'POST',
      headers: { 
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        timestamp: Date.now(),
        event: timingEvent
      }),
      signal: AbortSignal.timeout(2000) // 2s timeout, don't block buys
    });
    
    LOG('✅ Timing logged to server:', timingEvent.breakdowns.total + 'ms');
  } catch (err) {
    // Don't fail the buy if logging fails
    LOG('⚠️ Failed to log timing to server:', err.message);
  }
}

// -------- Utilities --------
// Cache regex outside function for performance
const TRAILING_SLASH = /\/$/;

const normalizeUrl = (u) => {
  if (!u) return "";
  try {
    const url = new URL(u);
    let path = url.pathname;
    if (path !== '/' && TRAILING_SLASH.test(path)) {
      path = path.slice(0, -1);
    }
    return `${url.origin}${path}${url.search}`;
  } catch {
    return String(u);
  }
};

// We include chain in the de-dupe key so BNB/SOL events don't collide.
function deDupeKey(tweet, orderId) {
  const base = tweet.statusUrl ? normalizeUrl(tweet.statusUrl) : (tweet.hash || "");
  const chain = (tweet && tweet.chain)
    ? String(tweet.chain)
    : (orderId && orderId.chain ? String(orderId.chain) : 'bnb');
  return `${chain}::${orderId}::${base}`;
}

function within(ttlMs, ts) {
  return (Date.now() - (ts || 0)) < ttlMs;
}

// -------- Normalization helpers for sniper matching --------
function normalizeHandle(h) {
  const s = String(h || '').trim().toLowerCase();
  return s.replace(/^@+/, '');
}

function normalizeType(t) {
  return String(t || '').trim().toLowerCase();
}

// ⚡ PERFORMANCE: Extract tweet ID from URL for fast comparison
// Instead of comparing "https://www.x.com/i/web/status/1234567890"
// we extract and compare just "1234567890" - saves crucial microseconds
function extractTweetId(url) {
  if (!url) return '';
  const match = url.match(/\/status\/(\d+)/);
  return match ? match[1] : '';
}


function parseAuthors(authorString) {
  if (!authorString) return [];
  
  return String(authorString)
    .split(',')
    .map(a => normalizeHandle(a))
    .filter(Boolean);
}

function parseReferenceUrls(urlString) {
  if (!urlString) return [];
  
  return String(urlString)
    .split(',')
    .map(url => {
      const tweetId = extractTweetId(url.trim());
      // Return tweet ID if found, otherwise return the full URL (lowercase for backward compat)
      return tweetId || url.trim().toLowerCase();
    })
    .filter(Boolean);
}

/**
 * matchesOrder(order, tweet) - OPTIMIZED with cached normalizations
 */
function matchesOrder(order, tweet) {
  // Skip paused orders
  if (order.paused) {
    return { matched: false, reason: "Order is paused" };
  }

  // Cache normalized order values for performance (avoid recomputing on every tweet)
  if (!order._normalized) {
    order._normalized = {
      type: normalizeType(order.tweetType || ''),
      authors: parseAuthors(order.author || ''),
      refUrls: parseReferenceUrls(order.referenceUrl || ''),
      wordsLower: (Array.isArray(order.contentWords) ? order.contentWords : [])
        .map(w => String(w || '').toLowerCase())
        .filter(Boolean)
    };
  }

  const { type: orderTypeNorm, authors: orderAuthors, refUrls: orderRefUrls, wordsLower } = order._normalized;

  // Normalize tweet fields once
  const tweetHandleNorm = normalizeHandle(tweet.handle || '');
  const tweetBodyLower  = String(tweet.text || '').toLowerCase();
  const tweetTypeNorm   = normalizeType(tweet.tweetType || '');
  const tweetCtxLower   = String(tweet.contextUrl || '').toLowerCase();

  LOG("Checking order strictly vs tweet:", {
    orderTypeNorm,
    orderAuthors,
    orderRefUrls,
    wordsLower,
    logicType: order.logicType,
    tweetTypeNorm,
    tweetHandleNorm,
    tweetCtxLower,
    tweetBodyPreview: tweetBodyLower.slice(0, 80)
  });

  // 1. tweetType must match if user specified a type
  if (orderTypeNorm) {
    if (orderTypeNorm !== tweetTypeNorm) {
      const reason = `❌ Type mismatch: expected ${orderTypeNorm} vs ${tweetTypeNorm}`;
      LOG(reason);
      return { matched: false, reason };
    }
    LOG("✅ tweetType matched:", orderTypeNorm);
  }

  // 2. author/@handle must match if user specified one
  if (orderAuthors.length > 0) {
    const authorMatched = orderAuthors.some(author => author === tweetHandleNorm);
    
    if (!authorMatched) {
      const reason = `❌ Author mismatch: expected one of [${orderAuthors.join(', ')}] vs ${tweetHandleNorm}`;
      return { matched: false, reason };
    }
    LOG("✅ author matched:", tweetHandleNorm, "from list:", orderAuthors);
  }

  // 3. reference URL must match if user specified one
  if (orderRefUrls.length > 0) {
    // ⚡ PERFORMANCE: Extract tweet ID once and compare IDs instead of full URLs
    // This is much faster than comparing "https://www.x.com/i/web/status/1234567890"
    const tweetId = extractTweetId(tweet.contextUrl || '');
    
    // Compare tweet IDs first (fast path), fallback to includes for non-tweet URLs
    const urlMatched = orderRefUrls.some(refUrl => {
      // If refUrl looks like a tweet ID (all digits), compare directly
      if (/^\d+$/.test(refUrl)) {
        return tweetId === refUrl;
      }
      // Otherwise, fallback to substring match (backward compatibility)
      return tweetCtxLower.includes(refUrl);
    });
    
    if (!urlMatched) {
      const reason = `❌ Reference URL mismatch: expected one of [${orderRefUrls.join(', ')}] not in ${tweetCtxLower} (ID: ${tweetId})`;
      LOG(reason);
      return { matched: false, reason };
    }
    LOG("✅ referenceUrl matched:", tweetId || tweetCtxLower, "from list:", orderRefUrls);
  }

  // 4. content word logic
  if (wordsLower.length > 0) {
    if (order.logicType === 'and') {
      // ALL words must appear
      const allPresent = wordsLower.every(word => tweetBodyLower.includes(word));
      if (!allPresent) {
        const reason = `❌ Not all words present (AND): ${wordsLower.join(', ')}`;
        LOG(reason);
        return { matched: false, reason };
      }
      LOG("✅ all words matched (AND):", wordsLower);
    } else {
      // default OR
      const anyPresent = wordsLower.some(word => tweetBodyLower.includes(word));
      if (!anyPresent) {
        const reason = `❌ No words present (OR): ${wordsLower.join(', ')}`;
        LOG(reason);
        return { matched: false, reason };
      }
      LOG("✅ at least one word matched (OR):", wordsLower);
    }
  }

  LOG("✅ ALL CHECKS PASSED - Order matched!");
  return { matched: true };
}

// -------- Notification helpers (non-blocking) --------
function triggerNotifications(order, tweet) {
  // Fire all notifications in parallel without blocking buy execution
  Promise.allSettled([
    sendPushcutNotification(order, tweet),
  ]).catch(e => LOG('Notification error', e));
}

async function sendPushcutNotification(order, tweet) {
  try {
    const chain = (order.chain || '').toLowerCase();
    const ca = String(order.ca || '').trim();
    const raydiumCa = String(order.raydiumCa || '').trim();
    
    let safeCA;
    if (chain === 'sol' && raydiumCa) {
      safeCA = encodeURIComponent(raydiumCa);
    } else {
      safeCA = encodeURIComponent(ca);
    }
    
    const axiomUrl = safeCA
      ? `https://axiom.trade/meme/${safeCA}?chain=${chain}`
      : `https://axiom.trade/pulse?chain=${chain}`;

    await fetch("https://api.pushcut.io/dgFiqnWsrigPOZLQIwgeg/notifications/SlitSniper", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        title: "🎯 SlitSniper Match!",
        text: `${tweet.name || tweet.handle || 'Order'} matched on ${chain.toUpperCase()}`,
        defaultAction: {
          url: axiomUrl
        }
      })
    });
  } catch (e) {
    LOG('Pushcut notification failed', e);
  }
}

async function playSniperSound() {
  try {
    const tabs = await chrome.tabs.query({ url: "*://*.uxento.io/*" });
    const tab = (tabs && tabs.length) ? (tabs.find(t => t.active && t.currentWindow) || tabs[0]) : null;
    if (tab) {
      chrome.tabs.sendMessage(tab.id, { type: 'play_sniper_sound' }).catch(() => {});
    }
  } catch (e) {
    LOG('Failed to send play_sniper_sound', e);
  }
}

async function openAxiomTabForOrder(order) {
  try {
    const chain = (order.chain || '').toLowerCase();
    const ca = String(order.ca || '').trim();
    const raydiumCa = String(order.raydiumCa || '').trim();

    let safeCA;
    if (chain === 'sol' && raydiumCa) {
      safeCA = encodeURIComponent(raydiumCa);
    } else {
      safeCA = encodeURIComponent(ca);
    }

    const url = safeCA
      ? `https://axiom.trade/meme/${safeCA}?chain=${chain}`
      : `https://axiom.trade/pulse?chain=${chain}`;

    const axTabs = await chrome.tabs.query({ url: "*://*.axiom.trade/*" }).catch(() => []);
    let createOpts = { url, active: true };

    if (axTabs && axTabs.length) {
      createOpts.windowId = axTabs[0].windowId;
    }

    const created = await chrome.tabs.create(createOpts).catch(e => { throw e; });
    LOG("[MemebuyUnified/bg] Opened Axiom tab", created?.id, url);
    return created;
  } catch (err) {
    LOG("[MemebuyUnified/bg] openAxiomTabForOrder error", err);
    return null;
  }
}

// =============== BUY EXECUTION HELPERS ===============

async function postJson(url, body, apiToken) {
  const headers = { 'content-type': 'application/json' };
  if (apiToken) headers['x-api-token'] = apiToken;
  
  const t0 = performance.now();
  const r = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
  const t1 = performance.now();
  
  let json = {};
  try { 
    json = await r.json(); 
  } catch (_e) {}
  const t2 = performance.now();
  
  // Calculate timing breakdown
  const networkMs = Math.round(t1 - t0);  // Network + signer processing
  const jsonParseMs = Math.round(t2 - t1); // JSON parsing time
  const totalMs = Math.round(t2 - t0);     // Total including JSON parse
  
  // Log JSON parse time if it's unusually high (helps debug cold starts)
  if (jsonParseMs > 10) {
    LOG(`⚠️ Slow JSON parse: ${jsonParseMs}ms (network: ${networkMs}ms)`);
  }
  
  return {
    ok: r.ok && json?.ok !== false,
    status: r.status,
    elapsedMs: networkMs,     // Network time (for backward compatibility)
    jsonParseMs,              // JSON parse time (new)
    totalMs,                  // Total time (new)
    json,
  };
}

function makeBnbSwapBody(msg) {
  const body = {
    token: msg.token,
    amountBNB: msg.amountBNB,
    gasGwei: msg.gasGwei,
    router: msg.router,
    dryRun: !!msg.dryRun,
    gasLimit: msg.gasLimit,
    slippage: msg.slippage,
    deadline: msg.deadline,
    mode: msg.mode || 'pancake',
    nightMode: !!msg.nightMode
  };
  
  // Add sell timing if night mode is enabled - SIMPLIFIED
  if (msg.nightMode && msg.sellAfterSeconds != null) {
    body.sellAfterSeconds = msg.sellAfterSeconds;
  }
  
  return body;
}
function makeSolSwapBody(msg) {
  const body = {
    token: msg.token,
    amount: msg.amountSOL,
    slippage: msg.slippage,
    priorityFee: msg.priorityFee,
    pool: msg.pool || 'auto',
    nightMode: !!msg.nightMode
  };
  
  // Add sell timing if night mode is enabled - SIMPLIFIED
  if (msg.nightMode && msg.sellAfterSeconds != null) {
    body.sellAfterSeconds = msg.sellAfterSeconds;
  }
  
  return body;
}

async function doManualBuy(msg, wsInstance = null) {
  // Lazy load settings only if not provided in msg
  let signerUrl = msg.signerUrl;
  let apiToken = msg.apiToken;

  if (!signerUrl || !apiToken) {
    const settings = await getSettings();
    signerUrl = signerUrl || settings.signerUrl || "http://127.0.0.1:8787/swap";
    apiToken = apiToken || settings.apiToken || "";
  }

  // Derive root of signer (strip /swap or /swapSol etc)
  let root;
  try {
    const u = new URL(signerUrl);
    root = `${u.protocol}//${u.host}`;
  } catch {
    root = signerUrl.replace(/\/swap.*/i, '').replace(/\/swapSol.*/i, '');
  }

  const chain = msg.signerChain === 'sol' || msg.chain === 'sol' ? 'sol' : 'bnb';
  const body = chain === 'sol' ? makeSolSwapBody(msg) : makeBnbSwapBody(msg);
  
  // ═══════════════════════════════════════════════════════════
  // 🚀 Try WebSocket first (2-3ms), fallback to HTTP (18ms)
  // ═══════════════════════════════════════════════════════════
  
  // Use provided WebSocket instance or default to signerWS (Wallet 1)
  const ws = wsInstance || signerWS;
  
  try {
    // Attempt WebSocket (ultra-fast)
    const wsResult = await ws.swap(body, chain);
    
    
    if (chain === 'sol') {
      return {
        ok: wsResult.ok,
        hash: wsResult.hash || wsResult.sig || wsResult.signature,
        sig: wsResult.sig || wsResult.signature || wsResult.hash,
        elapsedMs: wsResult.elapsedMs,
        mode: wsResult.mode || 'pumpportal',
        rpcUsed: wsResult.rpcUsed,
        timing: wsResult.timing,
        via: 'websocket',
        raw: wsResult.raw,
        error: wsResult.error
      };
    } else {
      return {
        ok: wsResult.ok,
        hash: wsResult.hash,
        elapsedMs: wsResult.elapsedMs,
        mode: wsResult.mode || 'broadcast-only',
        rpcUsed: wsResult.rpcUsed,
        gasPriceGwei: wsResult.gasPriceGwei,
        gasLimit: wsResult.gasLimit,
        timing: wsResult.timing,
        via: 'websocket',
        error: wsResult.error
      };
    }
    
  } catch (wsError) {
    // WebSocket failed, fallback to HTTP
    LOG(`⚠️ WebSocket failed (${wsError.message}), falling back to HTTP`);
    
    if (chain === 'sol') {
      const url = root + "/swapSol";
      LOG("Manual buy SOL → (HTTP fallback)", url, body);
      const out = await postJson(url, body, apiToken);

      return {
        ok: out.ok && out.json?.ok !== false,
        hash: out.json?.hash || out.json?.sig || out.json?.signature,
        sig: out.json?.sig || out.json?.signature || out.json?.hash,
        elapsedMs: out.json?.elapsedMs || out.elapsedMs,
        mode: out.json?.mode || 'pumpportal',
        rpcUsed: out.json?.rpcUsed,
        timing: out.json?.timing,
        via: 'http-fallback',
        raw: out.json?.raw,
        error: out.json?.error
      };
    } else {
      const url = root + "/swap";
      LOG("Manual buy BNB → (HTTP fallback)", url, body);
      const out = await postJson(url, body, apiToken);

      return {
        ok: out.ok && out.json?.ok  !== false,
        hash: out.json?.hash,
        elapsedMs: out.json?.elapsedMs || out.elapsedMs,
        mode: out.json?.mode || 'broadcast-only',
        rpcUsed: out.json?.rpcUsed,
        gasPriceGwei: out.json?.gasPriceGwei,
        gasLimit: out.json?.gasLimit,
        timing: out.json?.timing,
        via: 'http-fallback',
        error: out.json?.error
      };
    }
  }
}

// Helper: perform the multi-buy split and dispatch two buys in parallel
async function multiBuySolOrder(order, baseMsgBuilderFn) {
  try {
    // Lazy load settings for apiToken2
    const settings = await getSettings();
    const apiToken2 = settings?.apiToken2 || '';

    const total = Number(order.amount || order.amountSOL || order.amountSol || order.solAmount);
    if (!isFinite(total) || total <= 0) {
      return await doManualBuy(await baseMsgBuilderFn(order, total), signerWS);
    }

    // random deviation p in [0, +0.15] => wallet #1 always ≥ 50% of total
    const p = Math.random() * 0.2;
    const share1 = total * (0.5 + p);
    const w1 = Number(share1.toFixed(9));
    let w2 = Number((total - w1).toFixed(9));

    if (w2 <= 0) {
      return await doManualBuy(await baseMsgBuilderFn(order, total), signerWS);
    }

    // Build two manual-buy messages
    const msg1 = await baseMsgBuilderFn(order, w1);
    const msg2 = await baseMsgBuilderFn(order, w2);

    // Decide second signer endpoint based on chain
    const chain = String(order.chain || order.signerChain || '').toLowerCase();
    if (chain === 'sol') {
      msg2.signerUrl = "http://127.0.0.1:8789/swapSol";
    } else {
      msg2.signerUrl = "http://127.0.0.1:8789/swap";
    }
    msg2.apiToken = apiToken2;

    // Run both in parallel
    // Wallet 1: Always use signerWS (WebSocket)
    // Wallet 2: Use signerWS2 if available (WebSocket), otherwise null (HTTP fallback)
    const wallet2WS = wallet2Available ? signerWS2 : null;
    
    const [primaryRes, secondaryRes] = await Promise.all([
      doManualBuy(msg1, signerWS).catch(e => ({ ok: false, error: String(e) })),     // Wallet 1 WebSocket
      doManualBuy(msg2, wallet2WS).catch(e => ({ ok: false, error: String(e) }))    // Wallet 2 WebSocket or HTTP
    ]);

    const best = (primaryRes && primaryRes.ok) ? primaryRes : secondaryRes;
    const ok = !!(best && best.ok);
    
    return {
      ok,
      hash: best?.hash,
      sig: best?.sig,
      elapsedMs: best?.elapsedMs,
      mode: best?.mode,
      rpcUsed: best?.rpcUsed,
      gasPriceGwei: best?.gasPriceGwei,
      gasLimit: best?.gasLimit,
      timing: best?.timing,
      via: best?.via,
      raw: {
        primary: primaryRes,
        secondary: secondaryRes
      },
      split: { wallet1: w1, wallet2: w2 },
      error: best?.error
    };

  } catch (err) {
    return { ok: false, error: String(err) };
  }
}

async function autoBuyFromOrder(order, tweet, timingEvent) {
  const chain = (order.chain || '').toLowerCase() === 'sol' ? 'sol' : 'bnb';

  const buildMsgForAmount = async (o, amt) => {
    if (chain === 'sol') {
      return {
        signerChain: 'sol',
        chain: 'sol',
        token: o.ca,
        amountSOL: Number(amt),
        priorityFee: o.priorityFee ? Number(o.priorityFee) : undefined,
        slippage: o.slippage ? Number(o.slippage) : undefined,
        pool: o.pool || 'auto',
        dryRun: false,
        nightMode: !!o.nightMode,
        sellAfterSeconds: o.sellAfterSeconds || null
      };
    } else {
      // ⭐ BNB: Just pass slippage % to signer - signer will fetch quote and calculate minAmountOut
      const slippageValue = o.slippage ? Number(o.slippage) : 0;
      
      return {
        signerChain: 'bnb',
        chain: 'bnb',
        token: o.ca,
        amountBNB: Number(amt),
        gasGwei: o.gas ? Number(o.gas) : undefined,
        router: o.router,
        dryRun: false,
        slippage: slippageValue > 0 ? slippageValue : undefined,  // ⭐ Signer will use this to fetch quote
        deadline: o.deadline ? Number(o.deadline) : undefined,
        gasLimit: o.gasLimit ? Number(o.gasLimit) : undefined,
        mode: o.mode || 'pancake',
        nightMode: !!o.nightMode,
        sellAfterSeconds: o.sellAfterSeconds || null
      };
    }
  };

  // ═══════════════════════════════════════════════════════════
  // 🔥 CHECKPOINT 4: BUY STARTED - NETWORK TO SIGNER
  // ═══════════════════════════════════════════════════════════
  const buyStartTime = Date.now();
  timingEvent.stages.buyStarted = buyStartTime;

  let buyResult;
  if (order.multiBuy) {
    LOG(`📊 Multi-buy mode for ${order.amount} ${chain.toUpperCase()}`);
    buyResult = await multiBuySolOrder(order, buildMsgForAmount);
  } else {
    const totalAmt = Number(order.amount);
    const msg = await buildMsgForAmount(order, totalAmt);
    LOG(`📊 Single buy: ${totalAmt} ${chain.toUpperCase()} → ${order.ca?.substring(0, 10)}...`);
    buyResult = await doManualBuy(msg, signerWS);  // Use Wallet 1 WebSocket
  }

  // ═══════════════════════════════════════════════════════════
  // 🔥 CHECKPOINT 5: SIGNER RESPONDED
  // ═══════════════════════════════════════════════════════════
  const signerRespondedTime = Date.now();
  timingEvent.stages.signerResponded = signerRespondedTime;
  
  // Calculate network latency and signer processing time
  const signerElapsedMs = buyResult.elapsedMs || 0;
  timingEvent.breakdowns.networkToSigner = Math.max(0, signerRespondedTime - buyStartTime - signerElapsedMs);
  timingEvent.breakdowns.signerTotal = signerElapsedMs;
  timingEvent.breakdowns.networkFromSigner = 0;
  
  // Essential timing metrics
  LOG(`📊 Network → Signer: ${timingEvent.breakdowns.networkToSigner}ms | Signer Processing: ${signerElapsedMs}ms`);

  // ═══════════════════════════════════════════════════════════
  // 🔥 CHECKPOINT 6: BUY CONFIRMED
  // ═══════════════════════════════════════════════════════════
  const confirmedTime = Date.now();
  timingEvent.stages.buyConfirmed = {
    timestamp: confirmedTime,
    success: !!buyResult.ok,
    hash: buyResult.hash || buyResult.sig,
    error: buyResult.error
  };
  
  timingEvent.breakdowns.txPropagation = 0;
  timingEvent.breakdowns.confirmationLatency = confirmedTime - signerRespondedTime;
  timingEvent.breakdowns.total = confirmedTime - timingEvent.stages.tweetDetected;
  
  CRITICAL_LOG(`⏱️ [${timingEvent.breakdowns.total}ms TOTAL] Buy confirmed: ${buyResult.ok ? '✅' : '❌'}`);
  
  timingEvent.metadata.token = order.ca || tweet.contractAddr;
  timingEvent.metadata.chain = order.chain || 'bnb';
  timingEvent.metadata.orderName = order.name || `Order`;

  // Send timing to popup and server
  safeSendToPopup({
    type: 'timing_event',
    event: timingEvent
  });
  
  logTimingToServer(timingEvent).catch(err => {
    LOG('⚠️ Non-blocking server log error:', err);
  });

  return buyResult;
}

async function armSpecialWatcherFromOrder(order, tweet, timingEvent) {
  const url = "http://127.0.0.1:8790/special-buy";

  const amountBNB = Number(order.amount || 0);
  const gasGwei   = order.gas ? Number(order.gas) : undefined;

  const payload = { amountBNB };
  if (Number.isFinite(gasGwei) && gasGwei > 0) {
    payload.gasGwei = gasGwei;
  }

  // ═══════════════════════════════════════════════════════════
  // 🔥 CHECKPOINT 5: BUY SENT (t4)
  // ═══════════════════════════════════════════════════════════
  timingEvent.stages.buySent = Date.now();
  
  if (timingEvent.stages.orderMatched) {
    const matchedTime = timingEvent.stages.orderMatched.timestamp;
    timingEvent.breakdowns.sending = timingEvent.stages.buySent - matchedTime;
  }

  try {
    const t0 = performance.now();
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload)
    });
    const t1 = performance.now();
    const elapsedMs = Math.round(t1 - t0);

    let json = null;
    try { json = await res.json(); } catch { json = null; }

    // ═══════════════════════════════════════════════════════════
    // 🔥 CHECKPOINT 6: BUY CONFIRMED (t5)
    // ═══════════════════════════════════════════════════════════
    const success = res.ok && (!json || json.ok !== false);
    
    timingEvent.stages.buyConfirmed = {
      timestamp: Date.now(),
      success: success,
      hash: null,
      sig: null,
      error: json?.error
    };
    
    const confirmedTime = timingEvent.stages.buyConfirmed.timestamp;
    timingEvent.breakdowns.confirmation = confirmedTime - timingEvent.stages.buySent;
    timingEvent.breakdowns.total = confirmedTime - timingEvent.stages.tweetDetected;

    // 🔥 SEND COMPLETE TIMING EVENT TO POPUP
    safeSendToPopup({
      type: 'timing_event',
      event: timingEvent
    });
    // 🆕 ALSO SEND TO SERVER FOR PERSISTENT LOGGING
    logTimingToServer(timingEvent).catch(err => {
      LOG('⚠️ Non-blocking server log error:', err);
    });

    if (!success) {
      const errMsg = (json && json.error) || `special-buy service HTTP ${res.status}`;
      return {
        ok: false,
        error: errMsg,
        elapsedMs,
        via: "special-watcher"
      };
    }

    LOG("✅ Armed special BNB watcher via /special-buy", {
      amountBNB,
      gasGwei,
      elapsedMs,
      json
    });

    return {
      ok: true,
      hash: null,
      sig: null,
      elapsedMs,
      mode: "special",
      via: "special-watcher"
    };
  } catch (e) {
    const msg = e && e.message ? e.message : String(e);
    
    // Handle errors and still send timing
    timingEvent.stages.buyConfirmed = {
      timestamp: Date.now(),
      success: false,
      error: msg
    };
    
    const confirmedTime = timingEvent.stages.buyConfirmed.timestamp;
    timingEvent.breakdowns.confirmation = confirmedTime - timingEvent.stages.buySent;
    timingEvent.breakdowns.total = confirmedTime - timingEvent.stages.tweetDetected;
    
    safeSendToPopup({
      type: 'timing_event',
      event: timingEvent
    });
    // 🆕 ALSO SEND TO SERVER FOR PERSISTENT LOGGING
    logTimingToServer(timingEvent).catch(() => {});
    
    LOG("❌ Failed to arm special watcher", msg);
    return {
      ok: false,
      error: msg,
      via: "special-watcher"
    };
  }
}

// -------- Process single order match (helper for parallel processing) --------
async function processOrderMatch(order, idx, tweet, seenMap, timingEvent) {
  const matchStartTime = performance.now();
  const { matched, reason } = matchesOrder(order, tweet);
  const matchCheckTime = performance.now() - matchStartTime;
  
  if (!matched) {
    const summary = reason ? `no match: ${reason}` : 'no match';
    LOG(`Order ${idx}: ${summary} (checked in ${matchCheckTime.toFixed(1)}ms)`);
    safeSendToPopup({
      type: 'sniper_eval_result',
      idx,
      summary
    });
    return { matched: false, summary, needsSeenUpdate: false };
  }

  // ═══════════════════════════════════════════════════════════
  // 🔥 CHECKPOINT 4: ORDER MATCHED (t3)
  // ═══════════════════════════════════════════════════════════
  const matchedTime = Date.now();
  timingEvent.stages.orderMatched = {
    timestamp: matchedTime,
    orderIdx: idx,
    orderName: order.orderName || order.name || `Order #${idx}`
  };
  
  timingEvent.breakdowns.matching = matchedTime - timingEvent.stages.matchingStarted;
  
  
  // Store token info
  timingEvent.metadata.token = order.ca;
  timingEvent.metadata.chain = order.chain || 'bnb';

  // Match found!
  CRITICAL_LOG("✅ MATCHED ORDER", { idx, order });

  // Fire notifications in parallel (non-blocking)

  // Execute buy immediately
  let buyResult;
  try {
    if (order.specialBuy) {
      LOG("⚡ Special buy enabled; arming BNB watcher instead of direct CA buy", { idx, order });
      buyResult = await armSpecialWatcherFromOrder(order, tweet, timingEvent);
    } else {
      LOG("🚀 Executing auto-buy for order", idx);
      buyResult = await autoBuyFromOrder(order, tweet, timingEvent);
    }

    CRITICAL_LOG("💸 auto-buy result:", buyResult);
triggerNotifications(order, tweet);
    let summary;
    if (buyResult.ok) {
      if (order.specialBuy) {
        summary = `MATCH ✅ special watcher armed ⏱️${timingEvent.breakdowns.total}ms`;
      } else {
        const txid = buyResult.hash || buyResult.sig || '(no txid)';
        summary = `MATCH ✅ bought tx=${txid} ⏱️${timingEvent.breakdowns.total}ms`;
      }
    } else {
      summary = `MATCH ❌ buy failed: ${buyResult.error || 'unknown error'} ⏱️${timingEvent.breakdowns.total}ms`;
    }

    safeSendToPopup({
      type: 'sniper_eval_result',
      idx,
      summary
    });

    return { matched: true, summary, needsSeenUpdate: true };

  } catch (e) {
    const summary = `MATCH ❌ threw error: ${String(e)}`;
    LOG(`Order ${idx}: ${summary}`);

    safeSendToPopup({
      type: 'sniper_eval_result',
      idx,
      summary
    });

    return { matched: true, summary, needsSeenUpdate: false };
  }
}

// -------- Sniper trigger logic (OPTIMIZED - parallel processing) --------
async function processTweetForSniper(tweet, timingEvent) {
  LOG("processTweetForSniper got tweet:", tweet);

  // ═══════════════════════════════════════════════════════════
  // 🔥 CHECKPOINT 3: MATCHING STARTED (t2)
  // ═══════════════════════════════════════════════════════════

  const matchingStartTime = Date.now();
  const orders = await getOrders();
  const seenMap = await getSeen();
  timingEvent.stages.matchingStarted = Date.now();
  
  const storageLoadTime = timingEvent.stages.matchingStarted - matchingStartTime;

  // Process ALL orders in parallel instead of sequentially
  const results = await Promise.allSettled(
    orders.map((order, i) => processOrderMatch(order, i, tweet, seenMap, timingEvent))
  );
  
  const matchingCompleteTime = Date.now();
  const totalMatchingTime = matchingCompleteTime - timingEvent.stages.matchingStarted;

  // Batch update all orders at once - but only if something changed
  let hasChanges = false;
  const updatedOrders = orders.map((order, i) => {
    const result = results[i];
    if (result.status === 'fulfilled') {
      // ⭐ Auto-pause order if it matched
      const shouldPause = result.value.matched;
      
      if (shouldPause) {
        hasChanges = true; // Order needs to be paused
      }
      
      return {
        ...order,
        lastResult: result.value.summary,
        paused: shouldPause ? true : order.paused  // Pause on match, preserve existing state otherwise
      };
    } else {
      hasChanges = true; // Error occurred
      return {
        ...order,
        lastResult: `error: ${result.reason}`
      };
    }
  });

  // Batch update seenMap for matched orders
  const newSeenEntries = results
    .map((result, i) => {
      if (result.status === 'fulfilled' && result.value.needsSeenUpdate) {
        return [deDupeKey(tweet, i), Date.now()];
      }
      return null;
    })
    .filter(Boolean);

  // Only write to storage if something actually changed
  const storageWriteStart = performance.now();
  
  if (hasChanges) {
    await setOrders(updatedOrders);
  } else {
  }

  // Single storage write for seen map if needed
  if (newSeenEntries.length > 0) {
    Object.assign(seenMap, Object.fromEntries(newSeenEntries));
    await setSeen(seenMap);
  }
  
  const storageWriteTime = performance.now() - storageWriteStart;
}

// =============== MESSAGE HANDLER (popup <-> bg) ===============
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    if (!msg) {
      sendResponse({ ok: false, error: "no message" });
      return;
    }

    // Tweet events from content script → run sniper
    if (msg.type === "tweet_detected" ||
        msg.type === "tweet_event" ||
        msg.type === "sniper_eval") {

      const tweetReceivedTime = Date.now();

      // ═══════════════════════════════════════════════════════════
      // 🔥 CHECKPOINT 1: TWEET DETECTED (t0)
      // ═══════════════════════════════════════════════════════════
      const timingEvent = {
        id: `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
        stages: {
          tweetDetected: tweetReceivedTime  // Start the clock
        },
        breakdowns: {},
        metadata: {}
      };
      

      // Normalize incoming tweet struct
      const tweet = msg.tweet || msg.payload || {};

      // Ensure handle always has leading "@"
      if (tweet.handle && !/^@/.test(tweet.handle)) {
        tweet.handle = '@' + tweet.handle;
      }

      // ═══════════════════════════════════════════════════════════
      // 🔥 CHECKPOINT 2: TWEET PARSED (t1)
      // ═══════════════════════════════════════════════════════════
      const parsedTime = Date.now();
      timingEvent.stages.tweetParsed = parsedTime;
      timingEvent.breakdowns.parsing = parsedTime - tweetReceivedTime;
      
      
      // Store metadata
      timingEvent.metadata = {
        author: tweet.handle || tweet.author || '',
        tweetUrl: tweet.statusUrl || '',
        tweetType: tweet.tweetType || 'tweet'
      };

      LOG("📧 Tweet data:", {
        handle: tweet.handle,
        tweetType: tweet.tweetType,
        contextUrl: tweet.contextUrl,
        statusUrl: tweet.statusUrl,
        textPreview: String(tweet.text || '').slice(0, 80)
      });

      await processTweetForSniper(tweet, timingEvent);

      sendResponse({ ok: true, processed: true });
      return;
    }

    // Manual buy from popup
    if (msg.type === 'manual_buy') {
      LOG("🛒 manual_buy request from popup:", msg);

      try {
        const start = performance.now();
        
        // ⭐ Signer will fetch expectedTokens if slippage is set (no need to do it here)
        const buyResult = await doManualBuy(msg, signerWS);  // Use Wallet 1 WebSocket
        const end = performance.now();

        const elapsedMs = buyResult.elapsedMs ?? Math.round(end - start);

        sendResponse({
          ok: !!buyResult.ok,
          hash: buyResult.hash,
          sig: buyResult.sig,
          elapsedMs,
          mode: buyResult.mode,
          rpcUsed: buyResult.rpcUsed,
          gasPriceGwei: buyResult.gasPriceGwei,
          gasLimit: buyResult.gasLimit,
          timing: buyResult.timing,
          via: buyResult.via,
          raw: buyResult.raw,
          error: buyResult.error
        });
      } catch (e) {
        sendResponse({ ok: false, error: e?.message || String(e) });
      }

      return;
    }

    // Settings retrieval
    if (msg.type === 'get_settings') {
      const settings = await getSettings();
      sendResponse({ ok: true, settings });
      return;
    }

    // Settings update
    if (msg.type === 'set_settings') {
      const patch = msg.patch || {};
      const updated = await setSettings(patch);
      sendResponse({ ok: true, settings: updated });
      return;
    }

    // Orders retrieval
    if (msg.type === 'get_orders') {
      const orders = await getOrders();
      sendResponse({ ok: true, orders });
      return;
    }

    // Orders replace/save
    if (msg.type === 'set_orders') {
      if (!Array.isArray(msg.orders)) {
        sendResponse({ ok:false, error:'orders must be array' });
        return;
      }
      await setOrders(msg.orders);
      sendResponse({ ok:true });
      return;
    }

    // Add single order
    if (msg.type === 'add_order') {
      const orders = await getOrders();
      const toAdd = msg.order || {};
      orders.push(toAdd);
      await setOrders(orders);
      sendResponse({ ok:true, orders });
      return;
    }

    // Toggle pause
    if (msg.type === 'toggle_pause') {
      const idx = msg.index;
      const orders = await getOrders();
      if (orders[idx]) {
        orders[idx].paused = !orders[idx].paused;
        await setOrders(orders);
        sendResponse({ ok:true, order: orders[idx] });
      } else {
        sendResponse({ ok:false, error:'no such order' });
      }
      return;
    }

    sendResponse({ ok:false, error:"unknown message type" });
  })();

  return true;
});

let heartbeatInterval = null;

async function startHeartbeat() {
  if (heartbeatInterval) return; // Already running
  
  heartbeatInterval = setInterval(async () => {
    try {
      const settings = await getSettings();
      const signerUrl = settings?.signerUrl || 'http://127.0.0.1:8787/swap';
      
      // Extract base URL
      let root;
      try {
        const u = new URL(signerUrl);
        root = `${u.protocol}//${u.host}`;
      } catch {
        root = signerUrl.replace(/\/swap.*/i, '');
      }
      
      // Ping health endpoint (lightweight, no blockchain calls)
      const healthUrl = root + '/health';
      
      LOG('[Heartbeat] Pinging signer to keep warm...');
      const response = await fetch(healthUrl, {
        method: 'GET',
        signal: AbortSignal.timeout(5000) // 5s timeout
      });
      
      if (response.ok) {
        LOG('[Heartbeat] ✅ Signer warm');
      } else {
        LOG('[Heartbeat] ⚠️ Signer response:', response.status);
      }
    } catch (e) {
      LOG('[Heartbeat] ❌ Failed:', e.message);
    }
  }, 45000); // Every 45 seconds
  
  LOG('[Heartbeat] Started (45s interval)');
}

async function stopHeartbeat() {
  if (heartbeatInterval) {
    clearInterval(heartbeatInterval);
    heartbeatInterval = null;
    LOG('[Heartbeat] Stopped');
  }
}

// Start heartbeat when extension loads
startHeartbeat();
