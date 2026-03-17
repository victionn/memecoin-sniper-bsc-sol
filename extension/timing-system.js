// ==================================================================
// PERFORMANCE TIMING SYSTEM FOR SLITSNIPER ULTIMATE
// ==================================================================
// 
// This module tracks detailed timing from tweet detection → transaction confirmation
// 
// Key stages tracked:
// 1. Tweet detected (t0)
// 2. Tweet parsed (t1)
// 3. Order matching started (t2)
// 4. Order matched (t3)
// 5. Buy message sent (t4)
// 6. Buy confirmed (t5)
//
// Usage:
// 1. Add this code to popup.js
// 2. Integrate timing hooks in bg.js (see INTEGRATION GUIDE below)
// 3. View timing data in Debug panel
// ==================================================================

//----------------------------------------------
// TIMING STORAGE & UTILITIES
//----------------------------------------------

// Global timing log - stores last 50 timing events
const TIMING_LOG = [];
const MAX_TIMING_ENTRIES = 50;

// Timing event structure:
// {
//   id: unique identifier (timestamp-based)
//   stages: {
//     tweetDetected: timestamp,
//     tweetParsed: timestamp,
//     matchingStarted: timestamp,
//     orderMatched: { timestamp, orderIdx, orderName },
//     buySent: timestamp,
//     buyConfirmed: { timestamp, success, hash/sig, error }
//   },
//   breakdowns: {
//     parsing: ms,
//     matching: ms,
//     sending: ms,
//     confirmation: ms,
//     total: ms
//   },
//   metadata: {
//     chain: 'bnb' | 'sol',
//     author: '@handle',
//     tweetUrl: '...',
//     token: 'CA or mint'
//   }
// }

function createTimingEvent(tweetData) {
  return {
    id: `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
    stages: {
      tweetDetected: Date.now()
    },
    breakdowns: {},
    metadata: {
      author: tweetData?.author || '',
      tweetUrl: tweetData?.statusUrl || '',
      tweetType: tweetData?.type || 'tweet'
    }
  };
}

function addTimingStage(eventId, stage, data) {
  const event = TIMING_LOG.find(e => e.id === eventId);
  if (!event) return;
  
  const now = Date.now();
  
  if (typeof data === 'object') {
    event.stages[stage] = { timestamp: now, ...data };
  } else {
    event.stages[stage] = now;
  }
  
  // Calculate breakdowns
  calculateBreakdowns(event);
}

function calculateBreakdowns(event) {
  const s = event.stages;
  const b = event.breakdowns;
  
  // Parsing time: detected → parsed
  if (s.tweetDetected && s.tweetParsed) {
    b.parsing = s.tweetParsed - s.tweetDetected;
  }
  
  // Matching time: matching started → order matched
  if (s.matchingStarted && s.orderMatched) {
    const matchedTime = s.orderMatched.timestamp || s.orderMatched;
    b.matching = matchedTime - s.matchingStarted;
  }
  
  // Sending time: order matched → buy sent
  if (s.orderMatched && s.buySent) {
    const matchedTime = s.orderMatched.timestamp || s.orderMatched;
    b.sending = s.buySent - matchedTime;
  }
  
  // Confirmation time: buy sent → confirmed
  if (s.buySent && s.buyConfirmed) {
    const confirmedTime = s.buyConfirmed.timestamp || s.buyConfirmed;
    b.confirmation = confirmedTime - s.buySent;
  }
  
  // Total time: detected → confirmed
  if (s.tweetDetected && s.buyConfirmed) {
    const confirmedTime = s.buyConfirmed.timestamp || s.buyConfirmed;
    b.total = confirmedTime - s.tweetDetected;
  }
}

function addTimingEvent(event) {
  TIMING_LOG.unshift(event);
  if (TIMING_LOG.length > MAX_TIMING_ENTRIES) {
    TIMING_LOG.pop();
  }
  
  // Store in chrome.storage for persistence
  chrome.storage.local.set({ timingLog: TIMING_LOG.slice(0, 10) }); // Store last 10
}

// Load timing log on startup
chrome.storage.local.get(['timingLog'], (result) => {
  if (result.timingLog && Array.isArray(result.timingLog)) {
    TIMING_LOG.push(...result.timingLog);
  }
});

//----------------------------------------------
// TIMING DISPLAY FUNCTIONS
//----------------------------------------------

function formatTimingEntry(event) {
  const s = event.stages;
  const b = event.breakdowns;
  const m = event.metadata;
  
  // Time string
  const time = new Date(s.tweetDetected).toLocaleTimeString();
  
  // Status icon
  let statusIcon = '⏱️';
  if (s.buyConfirmed) {
    const success = s.buyConfirmed.success !== false;
    statusIcon = success ? '✅' : '❌';
  } else if (s.buySent) {
    statusIcon = '📤';
  } else if (s.orderMatched) {
    statusIcon = '🎯';
  }
  
  // Build output
  let output = `${statusIcon} [${time}] ${m.author || 'Unknown'}`;
  
  if (m.tweetType) {
    output += ` (${m.tweetType})`;
  }
  
  output += '\n';
  
  // Stage-by-stage breakdown
  if (s.tweetDetected) {
    output += `  └─ Tweet detected: 0ms\n`;
  }
  
  if (s.tweetParsed && b.parsing !== undefined) {
    output += `  └─ Tweet parsed: +${b.parsing}ms (${b.parsing}ms total)\n`;
  }
  
  if (s.matchingStarted && b.parsing !== undefined) {
    const totalSoFar = b.parsing;
    output += `  └─ Matching started: +0ms (${totalSoFar}ms total)\n`;
  }
  
  if (s.orderMatched) {
    const matchedTime = b.parsing + (b.matching || 0);
    const orderName = s.orderMatched.orderName || `Order #${s.orderMatched.orderIdx || '?'}`;
    output += `  └─ Order matched: +${b.matching || '?'}ms (${matchedTime}ms total)\n`;
    output += `     ↳ ${orderName}\n`;
  }
  
  if (s.buySent && b.sending !== undefined) {
    const totalSoFar = (b.parsing || 0) + (b.matching || 0) + b.sending;
    output += `  └─ Buy sent: +${b.sending}ms (${totalSoFar}ms total)\n`;
    if (m.token) output += `     ↳ ${m.token}\n`;
  }
  
  if (s.buyConfirmed) {
    const success = s.buyConfirmed.success !== false;
    const hash = s.buyConfirmed.hash || s.buyConfirmed.sig;
    output += `  └─ Buy ${success ? 'confirmed' : 'FAILED'}: +${b.confirmation || '?'}ms\n`;
    if (hash) output += `     ↳ ${hash.substring(0, 16)}...\n`;
    if (s.buyConfirmed.error) output += `     ↳ Error: ${s.buyConfirmed.error}\n`;
  }
  
  // Total time summary
  if (b.total !== undefined) {
    output += `  ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`;
    output += `  🏁 TOTAL: ${b.total}ms (${(b.total / 1000).toFixed(2)}s)\n`;
    
    // Breakdown percentages
    if (b.parsing && b.matching && b.sending && b.confirmation) {
      output += `  📊 Breakdown:\n`;
      output += `     • Parse: ${b.parsing}ms (${((b.parsing / b.total) * 100).toFixed(1)}%)\n`;
      output += `     • Match: ${b.matching}ms (${((b.matching / b.total) * 100).toFixed(1)}%)\n`;
      output += `     • Send: ${b.sending}ms (${((b.sending / b.total) * 100).toFixed(1)}%)\n`;
      output += `     • Confirm: ${b.confirmation}ms (${((b.confirmation / b.total) * 100).toFixed(1)}%)\n`;
    }
  }
  
  if (m.tweetUrl) {
    output += `  🔗 ${m.tweetUrl}\n`;
  }
  
  return output + '\n';
}

function renderTimingLog() {
  const debugLog = document.getElementById('logDebug');
  if (!debugLog) return;
  
  if (TIMING_LOG.length === 0) {
    debugLog.textContent = '⏱️ No timing data yet. Sniper events will appear here with detailed performance breakdowns.\n\n';
    debugLog.textContent += '💡 Each event shows:\n';
    debugLog.textContent += '   • Time spent in each stage (parsing, matching, sending, confirmation)\n';
    debugLog.textContent += '   • Total execution time from tweet detection to buy confirmation\n';
    debugLog.textContent += '   • Percentage breakdown of where time is spent\n';
    return;
  }
  
  // Show timing statistics summary
  let summary = '⚡ PERFORMANCE STATS (last 10 events):\n';
  
  const completedEvents = TIMING_LOG.filter(e => e.breakdowns.total !== undefined).slice(0, 10);
  
  if (completedEvents.length > 0) {
    const times = completedEvents.map(e => e.breakdowns.total);
    const avg = times.reduce((a, b) => a + b, 0) / times.length;
    const min = Math.min(...times);
    const max = Math.max(...times);
    
    summary += `   Average: ${avg.toFixed(0)}ms (${(avg / 1000).toFixed(2)}s)\n`;
    summary += `   Fastest: ${min}ms (${(min / 1000).toFixed(2)}s)\n`;
    summary += `   Slowest: ${max}ms (${(max / 1000).toFixed(2)}s)\n`;
    
    // Average stage breakdowns
    const avgParsing = completedEvents
      .filter(e => e.breakdowns.parsing)
      .reduce((sum, e) => sum + e.breakdowns.parsing, 0) / completedEvents.length;
    const avgMatching = completedEvents
      .filter(e => e.breakdowns.matching)
      .reduce((sum, e) => sum + e.breakdowns.matching, 0) / completedEvents.length;
    const avgSending = completedEvents
      .filter(e => e.breakdowns.sending)
      .reduce((sum, e) => sum + e.breakdowns.sending, 0) / completedEvents.length;
    const avgConfirm = completedEvents
      .filter(e => e.breakdowns.confirmation)
      .reduce((sum, e) => sum + e.breakdowns.confirmation, 0) / completedEvents.length;
    
    summary += `   Avg stages: Parse ${avgParsing.toFixed(0)}ms | Match ${avgMatching.toFixed(0)}ms | Send ${avgSending.toFixed(0)}ms | Confirm ${avgConfirm.toFixed(0)}ms\n`;
  }
  
  summary += '\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n';
  
  // Render individual events
  const eventDetails = TIMING_LOG
    .slice(0, 10)
    .map(e => formatTimingEntry(e))
    .join('\n');
  
  debugLog.textContent = summary + eventDetails;
}

//----------------------------------------------
// CLEAR TIMING LOG BUTTON
//----------------------------------------------

function addClearTimingButton() {
  const debugPanel = document.getElementById('panel-debug');
  if (!debugPanel) return;
  
  const card = debugPanel.querySelector('.card');
  if (!card) return;
  
  // Check if button already exists
  if (document.getElementById('btnClearTiming')) return;
  
  const buttonRow = card.querySelector('.row.gap');
  if (!buttonRow) return;
  
  const clearBtn = document.createElement('button');
  clearBtn.id = 'btnClearTiming';
  clearBtn.className = 'btn';
  clearBtn.textContent = 'Clear Timing';
  clearBtn.title = 'Clear performance timing log';
  
  clearBtn.addEventListener('click', () => {
    if (confirm('Clear all timing data?')) {
      TIMING_LOG.length = 0;
      chrome.storage.local.remove('timingLog');
      renderTimingLog();
      showPopupMessage('Timing log cleared');
    }
  });
  
  buttonRow.appendChild(clearBtn);
}

//----------------------------------------------
// INTEGRATION WITH EXISTING DEBUG REFRESH
//----------------------------------------------

// Override the existing refreshDebug function to show timing data
const originalRefreshDebug = window.refreshDebug;
window.refreshDebug = function() {
  // Call original function (if it exists)
  if (typeof originalRefreshDebug === 'function') {
    originalRefreshDebug();
  }
  
  // Add timing data
  renderTimingLog();
};

// Add clear button on load
window.addEventListener('load', () => {
  addClearTimingButton();
  
  // Render timing on initial load if Debug tab is active
  const debugTab = document.querySelector('.tab[data-tab="debug"]');
  if (debugTab && debugTab.classList.contains('active')) {
    renderTimingLog();
  }
});

//----------------------------------------------
// MESSAGE LISTENER FOR TIMING EVENTS FROM BG.JS
//----------------------------------------------

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.type === 'timing_event') {
    // New timing event received from bg.js
    const event = msg.event;
    addTimingEvent(event);
    
    // If debug tab is open, refresh display
    const debugTab = document.querySelector('.tab[data-tab="debug"]');
    if (debugTab && debugTab.classList.contains('active')) {
      renderTimingLog();
    }
    
    // Update orders panel with latest timing
    if (event.stages.orderMatched && event.breakdowns.total) {
      const orderIdx = event.stages.orderMatched.orderIdx;
      const timing = `${event.breakdowns.total}ms`;
      
      // Update the order row to show timing
      (async () => {
        const orders = await getOrders();
        if (orders[orderIdx]) {
          const lastResult = orders[orderIdx].lastResult || '';
          orders[orderIdx].lastResult = `${lastResult} ⏱️${timing}`;
          await setOrders(orders);
          
          // Live update if Orders tab is visible
          const rowSel = `.order-row[data-idx="${orderIdx}"] .last-result`;
          const node = document.querySelector(rowSel);
          if (node) {
            node.textContent = orders[orderIdx].lastResult;
          }
        }
      })();
    }
  }
  
  // Partial timing updates (for live progress)
  if (msg?.type === 'timing_update') {
    addTimingStage(msg.eventId, msg.stage, msg.data);
    
    // Refresh if debug tab is active
    const debugTab = document.querySelector('.tab[data-tab="debug"]');
    if (debugTab && debugTab.classList.contains('active')) {
      renderTimingLog();
    }
  }
});

//----------------------------------------------
// EXPORT FOR USE IN BG.JS (via shared context)
//----------------------------------------------

window.TimingSystem = {
  createEvent: createTimingEvent,
  addStage: addTimingStage,
  sendEvent: (event) => {
    // Send completed timing event to popup for display
    chrome.runtime.sendMessage({
      type: 'timing_event',
      event: event
    });
  },
  sendUpdate: (eventId, stage, data) => {
    // Send partial update
    chrome.runtime.sendMessage({
      type: 'timing_update',
      eventId: eventId,
      stage: stage,
      data: data
    });
  }
};