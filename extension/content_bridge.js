// content_bridge.js - Bridge between MAIN world and service worker
// This runs in ISOLATED world and has chrome.runtime access

console.log('[bridge] 🚀 ISOLATED world bridge loaded');

// Listen for messages from MAIN world (content_uxento.js)
window.addEventListener('message', async (event) => {
  // Security: only accept messages from same origin
  if (event.source !== window) return;
  
  const msg = event.data;
  if (!msg || msg.type !== 'UXENTO_TO_BRIDGE') return;

  console.log('[bridge] 📨 Received from MAIN world:', msg);
  console.log('[bridge] 📦 Payload type:', msg.payload?.type);
  console.log('[bridge] 📝 Payload data:', msg.payload?.payload);

  // Forward to service worker
  try {
    // Check if chrome.runtime is still available
    if (!chrome.runtime?.id) {
      return;
    }

    console.log('[bridge] 🚀 Sending to service worker:', msg.payload);
    const response = await chrome.runtime.sendMessage(msg.payload);
    
    
    console.log('[bridge] ✅ Service worker response:', response);
  } catch (e) {
    // Silently ignore extension context invalidation errors
    if (e.message?.includes('Extension context invalidated')) {
      console.debug('[bridge] Extension context invalidated - extension may have reloaded');
    } else {
      console.error('[bridge] ❌ Failed to send to service worker:', e);
      console.error('[bridge] ❌ Error details:', {
        message: e.message,
        stack: e.stack,
        name: e.name
      });
    }
  }
});

// Also handle requests from service worker (for popup debug, etc.)
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  console.log('[bridge] 📨 Received from service worker:', msg);

  if (msg.type === 'get_latest_toasts' || msg.type === 'get_snapshot_now') {
    // Forward to MAIN world
    window.postMessage({
      type: 'BRIDGE_TO_UXENTO',
      payload: msg
    }, '*');

    // Wait for response from MAIN world
    const listener = (event) => {
      if (event.source !== window) return;
      const data = event.data;
      if (data && data.type === 'UXENTO_RESPONSE') {
        window.removeEventListener('message', listener);
        sendResponse(data.payload);
      }
    };
    window.addEventListener('message', listener);

    return true; // Keep channel open for async response
  }

  sendResponse({ ok: false, error: 'Unknown message type' });
  return true;
});

console.log('[bridge] ✅ Bridge ready and listening');