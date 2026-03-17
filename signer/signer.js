import 'dotenv/config';
import { keccak256, toUtf8Bytes } from 'ethers';
import express from 'express';
import cors from 'cors';
import {
  JsonRpcProvider,
  Wallet,
  Interface,
  parseEther,
  parseUnits,
  getAddress,
  Transaction
} from 'ethers';

// --- Solana / cross-chain support imports ---
import fetch from 'node-fetch';
import bs58 from 'bs58';
import {
  Connection,
  PublicKey,
  Keypair,
  Transaction as SolTransaction,
  VersionedTransaction,
} from '@solana/web3.js';

// ===== NEW: Import http/https agents for connection pooling =====
import http from 'http';
import https from 'https';
// ═══════════════════════════════════════════════════════════════
// 🚀 WebSocket for ultra-low latency (~2ms vs ~18ms HTTP)
// ═══════════════════════════════════════════════════════════════
import { WebSocketServer } from 'ws';
// ════════════════════════════════════════════════════════════════
// 🆕 NEW: Import fs and path for timing log persistence
// ════════════════════════════════════════════════════════════════
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

// Get __dirname equivalent in ES modules
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const KEEPALIVE_INTERVAL_MS = 120000; // 2 minutes
let bscLastActivity = Date.now();
let solLastActivity = Date.now();

/**
 * ==========================
 * FAST PATH SIGNER (BSC + SOL) - OPTIMIZED
 *
 * NEW OPTIMIZATIONS:
 * - HTTP/HTTPS Agent with keepAlive for connection reuse
 * - Request timeout (5s default)
 * - Pre-warm connection to PumpPortal on startup
 * - Better error handling and timing logs
 *
 * ==========================
 */
const nightModeTimers = new Map(); 
const PORT = Number(process.env.PORT || 8787);

/* -------------------------
 * BSC / EVM CONFIG
 * ------------------------- */

// Primary RPC plus optional comma-separated list for multi-broadcast
const RPC_PRIMARY = process.env.BSC_RPC || 'https://bsc-dataseed.binance.org';
const RPC_LIST = (process.env.BSC_RPC_LIST || '')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean);

const RPCS = [RPC_PRIMARY, ...RPC_LIST];

// Security: use ONLY a burner key
const PRIV = process.env.PRIVATE_KEY;
const API_TOKEN = process.env.API_TOKEN || '';

if (!PRIV) {
  console.error('Missing PRIVATE_KEY in .env (use a burner wallet!)');
  process.exit(1);
}

/* -------------------------
 * SOLANA CONFIG
 * ------------------------- */

// PumpPortal Lightning API key
const PUMPPORTAL_API_KEY = process.env.PUMPPORTAL_API_KEY || '';

// Build Solana RPC list (kept for potential local mode / health / fallback)
const SOL_RPC_LIST_RAW = process.env.SOL_RPC_LIST || '';
const SOL_RPC_LIST_TMP = SOL_RPC_LIST_RAW
  .split(',')
  .map(s => s.trim())
  .filter(Boolean);

if (SOL_RPC_LIST_TMP.length === 0 && process.env.SOL_RPC) {
  SOL_RPC_LIST_TMP.push(process.env.SOL_RPC.trim());
}
const SOL_RPC_LIST = SOL_RPC_LIST_TMP;

// Reconstruct local Solana keypair from env (for future local mode / health)
let SOL_KEYPAIR = null;
if (process.env.SOL_PRIVATE_KEY_BASE58) {
  try {
    SOL_KEYPAIR = Keypair.fromSecretKey(
      Buffer.from(bs58.decode(process.env.SOL_PRIVATE_KEY_BASE58))
    );
  } catch (e) {
    console.error('Invalid SOL_PRIVATE_KEY_BASE58', e);
  }
} else if (process.env.SOL_PRIVATE_KEY_ARRAY) {
  try {
    SOL_KEYPAIR = Keypair.fromSecretKey(
      Uint8Array.from(JSON.parse(process.env.SOL_PRIVATE_KEY_ARRAY))
    );
  } catch (e) {
    console.error('Invalid SOL_PRIVATE_KEY_ARRAY', e);
  }
}

const SOLANA_ENABLED =
  !!PUMPPORTAL_API_KEY ||
  (!!SOL_KEYPAIR &&
    Array.isArray(SOL_RPC_LIST) &&
    SOL_RPC_LIST.length > 0);

/* -------------------------
 * ===== NEW: HTTP AGENTS FOR CONNECTION POOLING =====
 * ------------------------- */

// Create persistent HTTP agents with keepAlive
// This reuses TCP connections instead of creating new ones each request
const httpAgent = new http.Agent({
  keepAlive: true,
  keepAliveMsecs: 30000, // keep connections alive for 30s
  maxSockets: 10,        // allow up to 10 concurrent sockets
  maxFreeSockets: 5,     // keep 5 idle sockets ready
  timeout: 5000          // socket timeout
});

const httpsAgent = new https.Agent({
  keepAlive: true,
  keepAliveMsecs: 30000,
  maxSockets: 10,
  maxFreeSockets: 5,
  timeout: 5000
});

// Request timeout in ms (configurable via env)
const FETCH_TIMEOUT_MS = Number(process.env.FETCH_TIMEOUT_MS || 5000);
/* -------------------------
 * ════════════════════════════════════════════════════════════════
 * 🆕 TIMING LOG SETUP
 * ════════════════════════════════════════════════════════════════
 * ------------------------- */

// Create logs directory if it doesn't exist
const logsDir = path.join(__dirname, 'logs');
if (!fs.existsSync(logsDir)) {
  fs.mkdirSync(logsDir, { recursive: true });
  console.log(`📁 Created logs directory: ${logsDir}`);
}

const timingLogFile = path.join(logsDir, 'timing.log');

// Helper to append timing log entry
function appendTimingLog(timestamp, event) {
  try {
    const logEntry = JSON.stringify({ timestamp, event }) + '\n';
    fs.appendFileSync(timingLogFile, logEntry);
    
    // ═══════════════════════════════════════════════════════════════════════════
    // 🔬 ENHANCED TIMING BREAKDOWN - Full End-to-End View
    // ═══════════════════════════════════════════════════════════════════════════
    
    const total = event.breakdowns?.total || 0;
    const author = event.metadata?.author || 'Unknown';
    const success = event.stages?.buyConfirmed?.success;
    const statusIcon = success === true ? '✅' : success === false ? '❌' : '⏱️';
    const hash = event.stages?.buyConfirmed?.hash || 'N/A';
    
    console.log('\n╔═══════════════════════════════════════════════════════════════════════════╗');
    console.log('║              🎯 END-TO-END TIMING BREAKDOWN                               ║');
    console.log('╚═══════════════════════════════════════════════════════════════════════════╝');
    console.log(`⚡ ${statusIcon} [${new Date(timestamp).toLocaleTimeString()}] ${author} → ${total}ms total`);
    console.log(`📍 TX Hash: ${hash.slice(0, 10)}...${hash.slice(-8)}`);
    console.log(`🔗 Order: ${event.metadata?.orderName || 'Manual'} | Chain: ${(event.metadata?.chain || 'bnb').toUpperCase()}\n`);
    
    // ─────────────────────────────────────────────────────────────────────────
    // SECTION 1: Extension Timing (Tweet → Order Match)
    // ─────────────────────────────────────────────────────────────────────────
    const parsing = event.breakdowns?.parsing || 0;
    const matching = event.breakdowns?.matching || 0;
    const extensionTotal = parsing + matching;
    
    if (extensionTotal > 0) {
      console.log('  ┌─ Extension Processing ─────────────────────────────────────┐');
      console.log(`  │ Tweet Detection & Parse  │ ${parsing.toFixed(2).padStart(7)}ms │ ${((parsing/total)*100).toFixed(1).padStart(5)}% │`);
      console.log(`  │ Order Matching           │ ${matching.toFixed(2).padStart(7)}ms │ ${((matching/total)*100).toFixed(1).padStart(5)}% │`);
      console.log(`  │ Subtotal                 │ ${extensionTotal.toFixed(2).padStart(7)}ms │ ${((extensionTotal/total)*100).toFixed(1).padStart(5)}% │`);
      console.log('  └────────────────────────────────────────────────────────────┘\n');
    }
    
    // ─────────────────────────────────────────────────────────────────────────
    // SECTION 2: Network & Signer
    // ─────────────────────────────────────────────────────────────────────────
    const networkToSigner = event.breakdowns?.networkToSigner || 0;
    const signerTotal = event.breakdowns?.signerTotal || 0;
    const networkFromSigner = event.breakdowns?.networkFromSigner || 0;
    
    console.log('  ┌─ Network & Signer ─────────────────────────────────────────┐');
    console.log(`  │ Network → Signer         │ ${networkToSigner.toFixed(2).padStart(7)}ms │ ${((networkToSigner/total)*100).toFixed(1).padStart(5)}% │`);
    
    // Show detailed signer breakdown if available
    if (event.signerTiming && signerTotal > 0) {
      console.log(`  │ ├─ Signer Processing     │ ${signerTotal.toFixed(2).padStart(7)}ms │ ${((signerTotal/total)*100).toFixed(1).padStart(5)}% │`);
      
      const st = event.signerTiming;
      if (st.parseMs !== undefined && st.parseMs > 0) {
        console.log(`  │ │  ├─ Parse Request      │ ${st.parseMs.toFixed(2).padStart(7)}ms │ ${((st.parseMs/signerTotal)*100).toFixed(1).padStart(5)}% │`);
      }
      if (st.getGasMs !== undefined && st.getGasMs > 0) {
        console.log(`  │ │  ├─ Get Gas Price      │ ${st.getGasMs.toFixed(2).padStart(7)}ms │ ${((st.getGasMs/signerTotal)*100).toFixed(1).padStart(5)}% │`);
      }
      if (st.getNonceMs !== undefined && st.getNonceMs > 0) {
        console.log(`  │ │  ├─ Get Nonce          │ ${st.getNonceMs.toFixed(2).padStart(7)}ms │ ${((st.getNonceMs/signerTotal)*100).toFixed(1).padStart(5)}% │`);
      }
      if (st.buildTxMs !== undefined && st.buildTxMs > 0) {
        console.log(`  │ │  ├─ Build TX Object    │ ${st.buildTxMs.toFixed(2).padStart(7)}ms │ ${((st.buildTxMs/signerTotal)*100).toFixed(1).padStart(5)}% │`);
      }
      if (st.signTxMs !== undefined && st.signTxMs > 0) {
        console.log(`  │ │  ├─ Sign Transaction   │ ${st.signTxMs.toFixed(2).padStart(7)}ms │ ${((st.signTxMs/signerTotal)*100).toFixed(1).padStart(5)}% │`);
      }
      if (st.rpcStartMs !== undefined && st.rpcStartMs > 0) {
        console.log(`  │ │  ├─ RPC Call Start     │ ${st.rpcStartMs.toFixed(2).padStart(7)}ms │ ${((st.rpcStartMs/signerTotal)*100).toFixed(1).padStart(5)}% │`);
      }
      if (st.rpcProcessMs !== undefined && st.rpcProcessMs > 0) {
        const bar = '█'.repeat(Math.floor(st.rpcProcessMs / 5));
        console.log(`  │ │  ├─ RPC Processing     │ ${st.rpcProcessMs.toFixed(2).padStart(7)}ms │ ${((st.rpcProcessMs/signerTotal)*100).toFixed(1).padStart(5)}% │ ${bar}`);
      }
      if (st.buildResponseMs !== undefined && st.buildResponseMs > 0) {
        console.log(`  │ │  └─ Build Response     │ ${st.buildResponseMs.toFixed(2).padStart(7)}ms │ ${((st.buildResponseMs/signerTotal)*100).toFixed(1).padStart(5)}% │`);
      }
    } else {
      // No detailed timing, just show total
      console.log(`  │ Signer Processing        │ ${signerTotal.toFixed(2).padStart(7)}ms │ ${((signerTotal/total)*100).toFixed(1).padStart(5)}% │`);
    }
    
    if (networkFromSigner > 0) {
      console.log(`  │ Network ← Signer         │ ${networkFromSigner.toFixed(2).padStart(7)}ms │ ${((networkFromSigner/total)*100).toFixed(1).padStart(5)}% │`);
    }
    console.log('  └────────────────────────────────────────────────────────────┘\n');
    
    // ─────────────────────────────────────────────────────────────────────────
    // SECTION 3: Confirmation
    // ─────────────────────────────────────────────────────────────────────────
    const confirmation = event.breakdowns?.confirmationLatency || 0;
    
    if (confirmation > 0) {
      console.log('  ┌─ Transaction Confirmation ─────────────────────────────────┐');
      console.log(`  │ Confirmation Latency     │ ${confirmation.toFixed(2).padStart(7)}ms │ ${((confirmation/total)*100).toFixed(1).padStart(5)}% │`);
      console.log('  └────────────────────────────────────────────────────────────┘\n');
    }
    
    // ─────────────────────────────────────────────────────────────────────────
    // TOTAL
    // ─────────────────────────────────────────────────────────────────────────
    console.log('  ══════════════════════════════════════════════════════════════');
    console.log(`  ${'TOTAL'.padEnd(25)} │ ${total.toFixed(2).padStart(7)}ms │ 100.0% │`);
    console.log('  ══════════════════════════════════════════════════════════════\n');
    
  } catch (err) {
    console.error('❌ Failed to write timing log:', err.message);
  }
}

// Helper to read recent timing logs
function getRecentTimingLogs(limit = 50) {
  try {
    if (!fs.existsSync(timingLogFile)) {
      return [];
    }
    
    const data = fs.readFileSync(timingLogFile, 'utf8');
    const lines = data.trim().split('\n').filter(Boolean);
    
    return lines
      .slice(-limit) // Last N entries
      .map(line => JSON.parse(line))
      .reverse(); // Newest first
  } catch (err) {
    console.error('❌ Failed to read timing logs:', err.message);
    return [];
  }
}
/* -------------------------
 * EXPRESS APP SETUP
 * ------------------------- */

const app = express();
app.use(cors({
  origin: [
    /^chrome-extension:\/\//,
    /^http:\/\/127\.0\.0\.1(?::\d+)?$/,
    /^http:\/\/localhost(?::\d+)?$/
  ]
}));
app.use(express.json({ limit: '64kb' }));
app.post('/api/timing-log', (req, res) => {
  try {
    const { timestamp, event } = req.body;
    
    if (!timestamp || !event) {
      return err(res, 'Missing timestamp or event', 400);
    }
    
    appendTimingLog(timestamp, event);
    
    ok(res, { success: true });
  } catch (e) {
    console.error('❌ Timing log endpoint error:', e);
    err(res, e.message, 500);
  }
});

// GET /api/timing-logs - Get recent timing logs as JSON
app.get('/api/timing-logs', (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 50;
    const logs = getRecentTimingLogs(limit);
    
    ok(res, { logs });
  } catch (e) {
    console.error('❌ Failed to fetch timing logs:', e);
    err(res, e.message, 500);
  }
});

// GET /timing - Human-readable HTML view of timing logs
app.get('/timing', (req, res) => {
  try {
    const logs = getRecentTimingLogs(100);
    
    if (logs.length === 0) {
      return res.send(`
        <!DOCTYPE html>
        <html>
        <head>
          <title>⚡ Timing Logs</title>
          <style>
            body { 
              font-family: 'SF Mono', Monaco, 'Cascadia Code', 'Roboto Mono', Consolas, 'Courier New', monospace;
              background: #0d1117; 
              color: #c9d1d9; 
              padding: 40px;
              line-height: 1.6;
            }
            h1 { color: #58a6ff; margin-bottom: 30px; }
            .info { 
              background: #161b22; 
              padding: 20px; 
              border-radius: 8px; 
              border: 1px solid #30363d;
              margin-bottom: 20px;
            }
          </style>
        </head>
        <body>
          <h1>⚡ SlitSniper Timing Logs</h1>
          <div class="info">
            <p>📭 No timing events yet</p>
            <p>Logs will appear here automatically when your sniper executes trades.</p>
            <p style="margin-top: 15px; color: #8b949e;">Refresh this page after executing a trade to see timing data.</p>
          </div>
        </body>
        </html>
      `);
    }
    
    // Calculate statistics
    const completedEvents = logs
      .map(l => l.event)
      .filter(e => e.breakdowns?.total !== undefined);
    
    let statsHtml = '';
    if (completedEvents.length > 0) {
      const times = completedEvents.map(e => e.breakdowns.total);
      const avg = times.reduce((a, b) => a + b, 0) / times.length;
      const min = Math.min(...times);
      const max = Math.max(...times);
      
      const successCount = completedEvents.filter(e => e.stages?.buyConfirmed?.success === true).length;
      const failCount = completedEvents.filter(e => e.stages?.buyConfirmed?.success === false).length;
      
      statsHtml = `
        <div class="stats">
          <h2>📊 Statistics (Last ${completedEvents.length} events)</h2>
          <div class="stat-grid">
            <div class="stat-item">
              <div class="stat-label">Average</div>
              <div class="stat-value">${avg.toFixed(0)}ms</div>
              <div class="stat-sub">${(avg / 1000).toFixed(2)}s</div>
            </div>
            <div class="stat-item">
              <div class="stat-label">Fastest</div>
              <div class="stat-value">${min}ms</div>
              <div class="stat-sub">${(min / 1000).toFixed(2)}s</div>
            </div>
            <div class="stat-item">
              <div class="stat-label">Slowest</div>
              <div class="stat-value">${max}ms</div>
              <div class="stat-sub">${(max / 1000).toFixed(2)}s</div>
            </div>
            <div class="stat-item">
              <div class="stat-label">Success Rate</div>
              <div class="stat-value">${successCount}/${successCount + failCount}</div>
              <div class="stat-sub">${((successCount / (successCount + failCount)) * 100).toFixed(1)}%</div>
            </div>
          </div>
        </div>
      `;
    }
    
    // Generate event entries
    const eventsHtml = logs.map(log => {
      const e = log.event;
      const time = new Date(log.timestamp).toLocaleTimeString();
      const date = new Date(log.timestamp).toLocaleDateString();
      const total = e.breakdowns?.total || '?';
      const author = e.metadata?.author || 'Unknown';
      const chain = e.metadata?.chain || '?';
      const success = e.stages?.buyConfirmed?.success;
      
      let statusIcon = '⏱️';
      let statusClass = 'pending';
      if (success === true) {
        statusIcon = '✅';
        statusClass = 'success';
      } else if (success === false) {
        statusIcon = '❌';
        statusClass = 'failed';
      }
      
      let breakdownHtml = '';
      if (e.breakdowns?.parsing !== undefined) {
        breakdownHtml = `
          <div class="breakdown">
            <span class="breakdown-item">Parse: ${e.breakdowns.parsing}ms</span>
            <span class="breakdown-item">Match: ${e.breakdowns.matching || '?'}ms</span>
            <span class="breakdown-item">Send: ${e.breakdowns.sending || '?'}ms</span>
            <span class="breakdown-item">Confirm: ${e.breakdowns.confirmation || '?'}ms</span>
          </div>
        `;
      }
      
      let txLink = '';
      const hash = e.stages?.buyConfirmed?.hash || e.stages?.buyConfirmed?.sig;
      if (hash) {
        const explorer = chain === 'sol' || chain === 'solana' 
          ? `https://solscan.io/tx/${hash}`
          : `https://bscscan.com/tx/${hash}`;
        txLink = `<a href="${explorer}" target="_blank" class="tx-link">${hash.substring(0, 16)}...</a>`;
      }
      
      let errorMsg = '';
      if (e.stages?.buyConfirmed?.error) {
        errorMsg = `<div class="error">Error: ${e.stages.buyConfirmed.error}</div>`;
      }
      
      return `
        <div class="event ${statusClass}">
          <div class="event-header">
            <span class="status-icon">${statusIcon}</span>
            <span class="event-time">${date} ${time}</span>
            <span class="event-total">${total}ms</span>
          </div>
          <div class="event-details">
            <div class="event-info">
              <span class="event-author">${author}</span>
              <span class="event-chain">${chain.toUpperCase()}</span>
            </div>
            ${breakdownHtml}
            ${txLink ? `<div class="tx-hash">${txLink}</div>` : ''}
            ${errorMsg}
          </div>
        </div>
      `;
    }).join('');
    
    res.send(`
      <!DOCTYPE html>
      <html>
      <head>
        <title>⚡ Timing Logs</title>
        <meta http-equiv="refresh" content="5">
        <style>
          body { 
            font-family: 'SF Mono', Monaco, 'Cascadia Code', 'Roboto Mono', Consolas, 'Courier New', monospace;
            background: #0d1117; 
            color: #c9d1d9; 
            padding: 40px;
            line-height: 1.6;
            max-width: 1200px;
            margin: 0 auto;
          }
          h1 { 
            color: #58a6ff; 
            margin-bottom: 10px; 
            font-size: 2em;
          }
          h2 { 
            color: #58a6ff; 
            margin-top: 30px;
            margin-bottom: 20px;
            font-size: 1.3em;
          }
          .refresh-note {
            color: #8b949e;
            font-size: 0.9em;
            margin-bottom: 30px;
          }
          .stats {
            background: #161b22;
            padding: 25px;
            border-radius: 8px;
            border: 1px solid #30363d;
            margin-bottom: 30px;
          }
          .stat-grid {
            display: grid;
            grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
            gap: 20px;
            margin-top: 15px;
          }
          .stat-item {
            background: #0d1117;
            padding: 15px;
            border-radius: 6px;
            border: 1px solid #21262d;
          }
          .stat-label {
            color: #8b949e;
            font-size: 0.85em;
            margin-bottom: 5px;
          }
          .stat-value {
            color: #58a6ff;
            font-size: 1.5em;
            font-weight: bold;
          }
          .stat-sub {
            color: #8b949e;
            font-size: 0.85em;
            margin-top: 3px;
          }
          .event {
            background: #161b22;
            padding: 20px;
            border-radius: 8px;
            border: 1px solid #30363d;
            margin-bottom: 15px;
          }
          .event.success {
            border-left: 3px solid #3fb950;
          }
          .event.failed {
            border-left: 3px solid #f85149;
          }
          .event.pending {
            border-left: 3px solid #d29922;
          }
          .event-header {
            display: flex;
            align-items: center;
            gap: 15px;
            margin-bottom: 10px;
          }
          .status-icon {
            font-size: 1.3em;
          }
          .event-time {
            color: #8b949e;
            flex: 1;
          }
          .event-total {
            color: #58a6ff;
            font-weight: bold;
            font-size: 1.1em;
          }
          .event-details {
            margin-top: 10px;
            padding-top: 10px;
            border-top: 1px solid #21262d;
          }
          .event-info {
            display: flex;
            gap: 15px;
            margin-bottom: 8px;
          }
          .event-author {
            color: #c9d1d9;
            font-weight: bold;
          }
          .event-chain {
            color: #8b949e;
            font-size: 0.9em;
          }
          .breakdown {
            display: flex;
            gap: 15px;
            margin-top: 10px;
            font-size: 0.9em;
          }
          .breakdown-item {
            color: #8b949e;
          }
          .tx-hash {
            margin-top: 10px;
          }
          .tx-link {
            color: #58a6ff;
            text-decoration: none;
            font-size: 0.9em;
          }
          .tx-link:hover {
            text-decoration: underline;
          }
          .error {
            color: #f85149;
            margin-top: 8px;
            font-size: 0.9em;
          }
        </style>
      </head>
      <body>
        <h1>⚡ SlitSniper Timing Logs</h1>
        <div class="refresh-note">🔄 Auto-refreshing every 5 seconds | Total events: ${logs.length}</div>
        
        ${statsHtml}
        
        <h2>📋 Recent Events</h2>
        ${eventsHtml}
      </body>
      </html>
    `);
  } catch (e) {
    console.error('❌ Failed to render timing page:', e);
    res.status(500).send('Error rendering timing logs');
  }
});


/* -------------------------
 * BSC CORE (providers, wallet, helpers)
 * ------------------------- */

// Build providers (static network to skip chain detection)
const providers = RPCS.map(url => new JsonRpcProvider(url, 56, { staticNetwork: true }));

// Use first provider for reads; multi-broadcast for sends
const provider = providers[0];
const wallet   = new Wallet(PRIV, provider);

// ===== Addresses (lowercase literals; checksummed at runtime) =====
const ROUTER_DEFAULT_LC = '0x10ed43c718714eb63d5aa57b78b54704e256024e'; // Pancake V2
const ROUTER_BINANCE_EXCLUSIVE_LC = '0x8cFe327CEc66d1C090Dd72bd0FF11d690C33a2Eb'; // Binance-exclusive router
const WBNB_LC           = '0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c';

// ===== ABI / Interface (contractless encoding) =====
const ABI = [
  'function swapExactETHForTokensSupportingFeeOnTransferTokens(uint amountOutMin, address[] calldata path, address to, uint deadline) payable'
];
const IFACE = new Interface(ABI);

// ===== NEW: Four.meme + Pancake factory ABIs (for mode routing) =====

// ===== NEW: 4meme "ungraduated" router + token manager (for bonding curve) =====

// Router & token manager, same as your standalone script
const MEME_ROUTER_LC   = '0x1de460f363AF910f51726DEf188F9004276Bf4bc';
const TOKEN_MANAGER_LC = '0x5c952063c7fc8610ffdb798152d69f0b9550762b';

const MEME_ROUTER_ABI = [
  'function buyMemeToken(address tokenManager,address token,address recipient,uint256 funds,uint256 minAmount) external payable'
];

const MEME_IFACE     = new Interface(MEME_ROUTER_ABI);

// PancakeSwap V2 factory (for auto route detection)
const PCS_FACTORY_LC = '0xca143ce32fe78f1f7019d7d551a6402fc5350c73';
const PCS_FACTORY_ABI = [
  'function getPair(address tokenA, address tokenB) external view returns (address pair)'
];
const PCS_IFACE = new Interface(PCS_FACTORY_ABI);

// Minimal pair ABI for reserve checks (optional)
const PAIR_ABI = [
  'function getReserves() external view returns (uint112 reserve0, uint112 reserve1, uint32 blockTimestampLast)',
  'function token0() external view returns (address)',
  'function token1() external view returns (address)'
];
const PAIR_IFACE = new Interface(PAIR_ABI);

// Four.meme TokenManagerHelper3 (for ungraduated token quotes)
const HELPER3_ADDRESS = '0xF251F83e40a78868FcfA3FA4599Dad6494E46034';
const HELPER3_ABI = [
  'function tryBuy(address token, uint256 amount, uint256 funds) external view returns (address tokenManager, address quote, uint256 estimatedAmount, uint256 estimatedCost, uint256 estimatedFee, uint256 amountMsgValue, uint256 amountApproval, uint256 amountFunds)',
  'function getTokenInfo(address token) external view returns (uint256 version, address tokenManager, address quote, uint256 lastPrice, uint256 tradingFeeRate, uint256 minTradingFee, uint256 launchTime, uint256 offers, uint256 maxOffers, uint256 funds, uint256 maxFunds, bool liquidityAdded)'
];
const HELPER3_IFACE = new Interface(HELPER3_ABI);

// ===== Helpers =====
function normalize(addr) {
  const s = String(addr || '').trim();
  try { return getAddress(s); }
  catch { return getAddress(s.toLowerCase()); }
}

// ═══════════════════════════════════════════════════════════════
// 💧 GET EXPECTED TOKENS OUT - Fetch quote from PancakeSwap
// ═══════════════════════════════════════════════════════════════
async function getExpectedTokensOut(tokenAddress, amountBNB) {
  try {
    const t0 = Date.now();
    
    // PancakeSwap Router V2 on BSC
    const PANCAKE_ROUTER = '0x10ED43C718714eb63d5aA57B78B54704E256024E';
    const WBNB = '0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c';
    const bscRpc = 'https://bsc.rpc.blxrbdn.com';  // Use bloXroute (fast & reliable)
    
    console.log(`💧 [SIGNER] Fetching quote for ${amountBNB} BNB → ${tokenAddress}`);
    
    // Build the calldata for getAmountsOut(uint256 amountIn, address[] path)
    const amountInWei = BigInt(Math.floor(amountBNB * 1e18));
    
    // Function selector: 0xd06ca61f
    const selector = '0xd06ca61f';
    
    // ABI encode the parameters
    const amountHex = amountInWei.toString(16).padStart(64, '0');
    const wbnbHex = WBNB.slice(2).toLowerCase().padStart(64, '0');
    const tokenHex = tokenAddress.slice(2).toLowerCase().padStart(64, '0');
    
    // Full calldata (✅ FIXED: correct ABI encoding order)
    const data = selector +
      amountHex + // amountIn (FIRST parameter)
      '0000000000000000000000000000000000000000000000000000000000000040' + // offset to path array (SECOND parameter)
      '0000000000000000000000000000000000000000000000000000000000000002' + // path.length = 2
      wbnbHex + // path[0] = WBNB
      tokenHex; // path[1] = token
    
    const rpcPayload = {
      jsonrpc: '2.0',
      id: 1,
      method: 'eth_call',
      params: [{
        to: PANCAKE_ROUTER,
        data: data
      }, 'latest']
    };
    
    const response = await fetch(bscRpc, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(rpcPayload)
    });
    
    if (!response.ok) {
      console.error(`💧 [SIGNER] RPC HTTP error: ${response.status}`);
      return null;
    }
    
    const json = await response.json();
    
    if (json.error) {
      console.error(`💧 [SIGNER] RPC error:`, json.error);
      return null;
    }
    
    const result = json.result;
    if (!result || result === '0x') {
      console.error(`💧 [SIGNER] Empty result from getAmountsOut`);
      return null;
    }
    
    // Decode: result is uint256[] array with 2 elements
    // Result format: [0x][offset 32b][length 32b][amounts[0] 32b][amounts[1] 32b]
    // amounts[0] = amountIn echo (bytes 130-194)
    // amounts[1] = amountOut (bytes 194-258) ✅ THIS IS WHAT WE WANT
    const amounts1Hex = result.slice(194, 258);
    const expectedTokens = BigInt('0x' + amounts1Hex).toString();
    
    const elapsed = Date.now() - t0;
    console.log(`💧 [SIGNER] Quote fetched in ${elapsed}ms → ${expectedTokens} tokens`);
    
    return expectedTokens;
    
  } catch (err) {
    console.error(`💧 [SIGNER] getExpectedTokensOut failed:`, err.message);
    return null;
  }
}

// ═══════════════════════════════════════════════════════════════
// 💧 GET EXPECTED TOKENS OUT - Four.meme Bonding Curve (Ungraduated)
// ═══════════════════════════════════════════════════════════════
async function getExpectedTokensOutFourMeme(tokenAddress, amountBNB) {
  try {
    const t0 = Date.now();
    const bscRpc = 'https://bsc.rpc.blxrbdn.com';  // Use bloXroute (fast & reliable)
    
    console.log(`💧 [SIGNER] Fetching four.meme quote for ${amountBNB} BNB → ${tokenAddress}`);
    
    const amountInWei = BigInt(Math.floor(amountBNB * 1e18));
    
    // Call TokenManagerHelper3.tryBuy(token, amount=0, funds=amountBNB)
    // When amount=0, it calculates how many tokens you get for the given BNB
    const data = HELPER3_IFACE.encodeFunctionData('tryBuy', [
      tokenAddress,
      0n,              // amount = 0 (we want to buy with BNB, not a specific token amount)
      amountInWei      // funds = BNB amount
    ]);
    
    const rpcPayload = {
      jsonrpc: '2.0',
      id: 1,
      method: 'eth_call',
      params: [{
        to: HELPER3_ADDRESS,
        data: data
      }, 'latest']
    };
    
    const response = await fetch(bscRpc, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(rpcPayload)
    });
    
    if (!response.ok) {
      console.error(`💧 [SIGNER] Four.meme RPC HTTP error: ${response.status}`);
      return null;
    }
    
    const json = await response.json();
    
    if (json.error) {
      console.error(`💧 [SIGNER] Four.meme RPC error:`, json.error);
      return null;
    }
    
    const result = json.result;
    if (!result || result === '0x') {
      console.error(`💧 [SIGNER] Empty result from four.meme quote`);
      return null;
    }
    
    // Decode the tuple result
    // tryBuy returns: (tokenManager, quote, estimatedAmount, estimatedCost, estimatedFee, amountMsgValue, amountApproval, amountFunds)
    const decoded = HELPER3_IFACE.decodeFunctionResult('tryBuy', result);
    const estimatedAmount = decoded[2]; // estimatedAmount is at index 2
    
    const expectedTokens = estimatedAmount.toString();
    
    const elapsed = Date.now() - t0;
    console.log(`💧 [SIGNER] Four.meme quote fetched in ${elapsed}ms → ${expectedTokens} tokens`);
    
    return expectedTokens;
    
  } catch (err) {
    console.error(`💧 [SIGNER] getExpectedTokensOutFourMeme failed:`, err.message);
    return null;
  }
}

// ═══════════════════════════════════════════════════════════════
// 💧 SMART QUOTE FETCHING - Auto-detects graduated vs ungraduated
// ═══════════════════════════════════════════════════════════════
async function getExpectedTokensOutSmart(tokenAddress, amountBNB, routeHint = null) {
  try {
    // If route is explicitly specified, use that route
    if (routeHint === 'four') {
      return await getExpectedTokensOutFourMeme(tokenAddress, amountBNB);
    }
    
    if (routeHint === 'pancake') {
      return await getExpectedTokensOut(tokenAddress, amountBNB);
    }
    
    // Auto-detect: try PancakeSwap first (faster for graduated tokens)
    console.log(`💧 [SIGNER] Auto-detecting route for ${tokenAddress}...`);
    
    const pancakeQuote = await getExpectedTokensOut(tokenAddress, amountBNB);
    if (pancakeQuote) {
      console.log(`💧 [SIGNER] ✅ Token is GRADUATED - using PancakeSwap`);
      return pancakeQuote;
    }
    
    // If PancakeSwap fails, try four.meme bonding curve
    console.log(`💧 [SIGNER] PancakeSwap failed, trying four.meme bonding curve...`);
    const fourMemeQuote = await getExpectedTokensOutFourMeme(tokenAddress, amountBNB);
    
    if (fourMemeQuote) {
      console.log(`💧 [SIGNER] ✅ Token is UNGRADUATED - using four.meme bonding curve`);
      return fourMemeQuote;
    }
    
    console.error(`💧 [SIGNER] ❌ Both routes failed for ${tokenAddress}`);
    return null;
    
  } catch (err) {
    console.error(`💧 [SIGNER] getExpectedTokensOutSmart failed:`, err.message);
    return null;
  }
}

const ZERO_ADDRESS   = '0x0000000000000000000000000000000000000000';
const MEME_ROUTER    = normalize(MEME_ROUTER_LC);
const TOKEN_MANAGER  = normalize(TOKEN_MANAGER_LC);
const PCS_FACTORY    = normalize(PCS_FACTORY_LC);
const ROUTER_BINANCE_EXCLUSIVE = normalize(ROUTER_BINANCE_EXCLUSIVE_LC);


const ok  = (res, data)          => res.status(200).json(data);
const err = (res, msg, code=400) => res.status(code).json({ ok: false, error: msg });

/* -------------------------
 * GAS CACHE (BSC)
 * ------------------------- */

let cachedGasPrice = parseUnits('3', 'gwei'); // fallback default
let gasLastUpdated = 0;

async function refreshGasPrice() {
  try {
    const hex = await provider.send('eth_gasPrice', []);
    cachedGasPrice = BigInt(hex);
    gasLastUpdated = Date.now();
  } catch (e) {
    // keep previous cachedGasPrice if RPC fails
  }
}


console.log('🚀 Initializing signer...\n');

// CRITICAL: Warm crypto FIRST (before any gas price fetch)
// This eliminates the 30-50ms cold start penalty on first signature
await preWarmCrypto();

// Then warm RPC connections in parallel
await Promise.all([
  preWarmBscRpc(),
  preWarmPumpPortal()
]);

// Now fetch gas price with fully warmed connections and crypto
console.log('[INIT] 📊 Fetching initial gas price...');
await refreshGasPrice();
console.log(`[INIT] ✅ Gas price cached: ${(Number(cachedGasPrice) / 1e9).toFixed(2)} gwei\n`);
setInterval(refreshGasPrice, 2000);

/* -------------------------
 * NONCE MANAGER (BSC)
 * ------------------------- */

let nextNonce = null;
let nonceLock = Promise.resolve(); // promise chain for atomicity
const addrPromise = wallet.getAddress();

async function initNonce() {
  const address = await addrPromise;
  nextNonce = await provider.getTransactionCount(address, 'pending');
}
await initNonce();

// Reconcile every 5s to catch external txs / reorg effects
setInterval(async () => {
  try {
    const address = await addrPromise;
    const chainPending = await provider.getTransactionCount(address, 'pending');
    if (nextNonce === null || chainPending > nextNonce) {
      nextNonce = chainPending;
    }
  } catch {}
}, 5000);

async function takeNonce() {
  // queue ops to preserve ordering
  return (nonceLock = nonceLock.then(async () => {
    if (nextNonce === null) {
      await initNonce();
    }
    const n = nextNonce;
    nextNonce = n + 1;
    return n;
  }));
}

/* -------------------------
 * MULTI-RPC BROADCAST (BSC)
 * ------------------------- */

async function broadcastRawTxToAll(raw) {
  // Try primary first for lowest latency
  try {
    const hash = await provider.send('eth_sendRawTransaction', [raw]);
    return hash;
  } catch (_) {
    // ignore and keep racing others
  }

  const others = providers.slice(1);
  if (others.length === 0) {
    // only one RPC available
    return await provider.send('eth_sendRawTransaction', [raw]);
  }

  const attempts = others.map(p =>
    p.send('eth_sendRawTransaction', [raw])
      .catch(e => { throw e; })
  );

  if (Promise.any) {
    return await Promise.any(attempts);
  } else {
    // manual Promise.any fallback
    return await new Promise((resolve, reject) => {
      let rejections = 0;
      const errors = [];
      attempts.forEach(pr => {
        pr.then(resolve).catch(e => {
          rejections += 1; errors.push(e);
          if (rejections === attempts.length) {
            reject(errors[0] || new Error('all broadcasts failed'));
          }
        });
      });
    });
  }
}

/* -------------------------
 * NIGHT MODE SELL HELPERS
 * ------------------------- */

/**
 * Query BEP20 token balance for wallet
 */
async function getTokenBalance(tokenAddr) {
  try {
    const balanceAbi = ['function balanceOf(address) view returns (uint256)'];
    const balanceIface = new Interface(balanceAbi);
    const data = balanceIface.encodeFunctionData('balanceOf', [await addrPromise]);
    const rawBalance = await provider.call({ to: tokenAddr, data });
    const [balance] = balanceIface.decodeFunctionResult('balanceOf', rawBalance);
    return balance;
  } catch (e) {
    console.error('[NIGHT MODE] Balance query failed:', e);
    return 0n;
  }
}

/**
 * Sell BNB tokens (swap token -> BNB)
 */
/**
 * Sell BNB tokens (swap token -> BNB)
 */
async function sellBnbTokens(tokenAddr, amountTokens, gasGwei, sellNumber = 1) {
  try {
    console.log(`[NIGHT MODE] Selling ${amountTokens.toString()} tokens of ${tokenAddr}`);
    
    const ROUTER = normalize(ROUTER_DEFAULT_LC);
    const WBNB = normalize(WBNB_LC);
    const toAddr = await addrPromise;
    
    // ⭐ Determine gas price based on which sell
    const gasPriceToUse = sellNumber === 1 
      ? parseUnits('11', 'gwei')  // First sell: 11 gwei
      : parseUnits('1', 'gwei');   // Second sell: 1 gwei
    
    console.log(`[NIGHT MODE] Using ${sellNumber === 1 ? '11' : '1'} gwei for sell #${sellNumber}`);
    
    // ⭐ STEP 1: Check if router has enough allowance, approve if needed
    const approveAbi = [
      'function allowance(address owner, address spender) view returns (uint256)',
      'function approve(address spender, uint256 amount) returns (bool)'
    ];
    const approveIface = new Interface(approveAbi);
    
    // Check current allowance
    const allowanceData = approveIface.encodeFunctionData('allowance', [toAddr, ROUTER]);
    const rawAllowance = await provider.call({ to: tokenAddr, data: allowanceData });
    const [currentAllowance] = approveIface.decodeFunctionResult('allowance', rawAllowance);
    
    console.log(`[NIGHT MODE] Current allowance: ${currentAllowance.toString()}`);
    console.log(`[NIGHT MODE] Amount to sell: ${amountTokens.toString()}`);
    
    // If allowance is insufficient, approve
    if (currentAllowance < amountTokens) {
      console.log(`[NIGHT MODE] 🔓 Approving router to spend tokens...`);
      
      // Approve max amount for future sells
      const maxApproval = BigInt('0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff');
      const approveData = approveIface.encodeFunctionData('approve', [ROUTER, maxApproval]);
      
      // Use same gas as the sell for approval
      const nonce = await takeNonce();
      
      const approveTx = {
        chainId: 56,
        to: tokenAddr,
        value: 0n,
        data: approveData,
        gasPrice: gasPriceToUse,  // Use same gas as sell
        gasLimit: 100000n,
        nonce,
        type: 0
      };
      
      const approveRaw = await wallet.signTransaction(approveTx);
      const approveParsed = Transaction.from(approveRaw);
      const approveHash = approveParsed.hash;
      
      await broadcastRawTxToAll(approveRaw);
      console.log(`[NIGHT MODE] ✅ Approval tx: ${approveHash}`);
      
      // Wait 1 second for approval to confirm
      await new Promise(resolve => setTimeout(resolve, 1000));
    } else {
      console.log(`[NIGHT MODE] ✅ Router already approved`);
    }
    
    // ⭐ STEP 2: Now execute the sell
    const path = [tokenAddr, WBNB];
    const deadline = BigInt(Math.floor(Date.now() / 1000) + 20 * 60);
    const amountOutMin = 0n;
    
    const sellAbi = [
      'function swapExactTokensForETHSupportingFeeOnTransferTokens(uint amountIn, uint amountOutMin, address[] calldata path, address to, uint deadline)'
    ];
    const sellIface = new Interface(sellAbi);
    const data = sellIface.encodeFunctionData(
      'swapExactTokensForETHSupportingFeeOnTransferTokens',
      [amountTokens, amountOutMin, path, toAddr, deadline]
    );
    
    const GAS_LIMIT = 300000n;
    const nonce = await takeNonce();
    
    const tx = {
      chainId: 56,
      to: ROUTER,
      value: 0n,
      data,
      gasPrice: gasPriceToUse,  // Use determined gas price
      gasLimit: GAS_LIMIT,
      nonce,
      type: 0
    };
    
    const raw = await wallet.signTransaction(tx);
    const parsed = Transaction.from(raw);
    const hash = parsed.hash;
    
    await broadcastRawTxToAll(raw);
    
    console.log(`[NIGHT MODE] ✅ Sell #${sellNumber} executed: ${hash}`);
    return { ok: true, hash };
    
  } catch (e) {
    console.error(`[NIGHT MODE] ❌ Sell #${sellNumber} failed:`, e.message);
    return { ok: false, error: e.message };
  }
}
/**
 * Sell SOL tokens (swap token -> SOL via PumpPortal)
 */
async function sellSolTokens(mint, amountTokens, priorityFee) {
  try {
    console.log(`[NIGHT MODE] Selling ${amountTokens.toString()} SOL tokens of ${mint}`);
    
    if (!PUMPPORTAL_API_KEY) {
      throw new Error('PumpPortal API key missing');
    }
    
    // PumpPortal sell request
    const formBody = new URLSearchParams({
      action: 'sell',
      mint: String(mint).trim(),
      amount: String(amountTokens),
      denominatedInSol: 'false', // Amount is in tokens, not SOL
      slippage: '50', // High slippage for fast exit
      priorityFee: String(priorityFee || 0.00005),
      pool: 'auto',
      skipPreflight: 'true',
      jitoOnly: 'false'
    });
    
    const tradeUrl = `https://pumpportal.fun/api/trade?api-key=${encodeURIComponent(PUMPPORTAL_API_KEY)}`;
    
    const pumpRes = await fetchWithTimeout(tradeUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Connection': 'keep-alive'
      },
      body: formBody.toString()
    });
    
    if (!pumpRes.ok) {
      throw new Error(`PumpPortal HTTP ${pumpRes.status}`);
    }
    
    const pumpJson = await pumpRes.json();
    const sig = pumpJson.signature || pumpJson.sig || null;
    
    
    if (!sig) {
      throw new Error(pumpJson.error || 'No signature returned');
    }
    
    console.log(`[NIGHT MODE] ✅ Sell executed: ${sig}`);
    return { ok: true, sig };
    
  } catch (e) {
    console.error('[NIGHT MODE] ❌ SOL sell failed:', e.message);
    return { ok: false, error: e.message };
  }
}

/**
 * Sell ungraduated four.meme tokens (bonding curve)
 * Calls TOKEN_MANAGER directly with function selector 0x06e7b98f
 */
async function sellUngraduatedToken(tokenAddr, amountTokens, gasGwei, sellNumber = 1) {
  try {
    console.log(`[NIGHT MODE] 🔄 Selling UNGRADUATED ${amountTokens.toString()} tokens of ${tokenAddr}`);
    
    const toAddr = await addrPromise;
    
    // ⚡ Verify we actually have the tokens
    const actualBalance = await getTokenBalance(tokenAddr);
    console.log(`[NIGHT MODE] 💰 Token balance: ${actualBalance.toString()}`);
    
    if (actualBalance < amountTokens) {
      console.error(`[NIGHT MODE] ❌ Insufficient balance! Have ${actualBalance.toString()}, need ${amountTokens.toString()}`);
      return { ok: false, error: 'Insufficient token balance' };
    }
    
    // Determine gas price
    const gasPriceToUse = sellNumber === 1 
      ? parseUnits('11', 'gwei')  // First sell: 11 gwei
      : parseUnits('1', 'gwei');   // Second sell: 1 gwei
    
    console.log(`[NIGHT MODE] Using ${sellNumber === 1 ? '11' : '1'} gwei for ungraduated sell #${sellNumber}`);
    
    // Step 1: Approve TOKEN_MANAGER (NOT MEME_ROUTER) to spend tokens
    const approveAbi = [
      'function allowance(address owner, address spender) view returns (uint256)',
      'function approve(address spender, uint256 amount) returns (bool)'
    ];
    const approveIface = new Interface(approveAbi);
    
    const allowanceData = approveIface.encodeFunctionData('allowance', [toAddr, TOKEN_MANAGER]);
    const rawAllowance = await provider.call({ to: tokenAddr, data: allowanceData });
    const [currentAllowance] = approveIface.decodeFunctionResult('allowance', rawAllowance);
    
    console.log(`[NIGHT MODE] 🔍 Allowance check:`);
    console.log(`[NIGHT MODE]   Current TOKEN_MANAGER allowance: ${currentAllowance.toString()}`);
    console.log(`[NIGHT MODE]   Amount to sell: ${amountTokens.toString()}`);
    console.log(`[NIGHT MODE]   Sufficient: ${currentAllowance >= amountTokens ? '✅' : '❌'}`);
    
    if (currentAllowance < amountTokens) {
      console.log(`[NIGHT MODE] 🔓 Approving TOKEN_MANAGER to spend tokens...`);
      
      const maxApproval = BigInt('0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff');
      const approveData = approveIface.encodeFunctionData('approve', [TOKEN_MANAGER, maxApproval]);
      
      const nonce = await takeNonce();
      const approveTx = {
        chainId: 56,
        to: tokenAddr,
        value: 0n,
        data: approveData,
        gasPrice: gasPriceToUse,
        gasLimit: 100000n,
        nonce,
        type: 0
      };
      
      const approveRaw = await wallet.signTransaction(approveTx);
      const approveParsed = Transaction.from(approveRaw);
      const approveHash = approveParsed.hash;
      
      await broadcastRawTxToAll(approveRaw);
      console.log(`[NIGHT MODE] ✅ TOKEN_MANAGER Approval tx: ${approveHash}`);
      
      // Wait 1 second for approval to propagate
      await new Promise(resolve => setTimeout(resolve, 1000));
    } else {
      console.log(`[NIGHT MODE] ✅ TOKEN_MANAGER already approved`);
    }
    
    // Step 2: Call TOKEN_MANAGER directly with function selector 0x06e7b98f
    // Based on successful transaction analysis
    // Function takes 6 parameters: (uint256, address, uint256, uint256, uint256, address)
    
    const functionSelector = '0x06e7b98f';
    
    // Encode parameters using temporary interface
    const tempAbi = ['function sell(uint256,address,uint256,uint256,uint256,address)'];
    const tempIface = new Interface(tempAbi);
    const encodedCall = tempIface.encodeFunctionData('sell', [
      0n,              // param 1: always 0
      tokenAddr,       // param 2: token address
      amountTokens,    // param 3: amount to sell
      0n,              // param 4: min BNB out (0 = no slippage protection)
      0n,              // param 5: slippage setting (0 per user request)
      toAddr           // param 6: fee recipient (use your own address)
    ]);
    
    // Replace the function selector from tempIface with the actual one
    const sellData = functionSelector + encodedCall.slice(10);
    
    const GAS_LIMIT = 300000n;
    const nonce = await takeNonce();
    
    const tx = {
      chainId: 56,
      to: TOKEN_MANAGER,  // Call TOKEN_MANAGER directly
      value: 0n,
      data: sellData,
      gasPrice: gasPriceToUse,
      gasLimit: GAS_LIMIT,
      nonce,
      type: 0
    };
    
    const raw = await wallet.signTransaction(tx);
    const parsed = Transaction.from(raw);
    const hash = parsed.hash;
    
    await broadcastRawTxToAll(raw);
    
    console.log(`[NIGHT MODE] ✅ Ungraduated sell #${sellNumber} executed: ${hash}`);
    return { ok: true, hash };
    
  } catch (e) {
    console.error(`[NIGHT MODE] ❌ Ungraduated sell #${sellNumber} failed:`, e.message);
    return { ok: false, error: e.message };
  }
}

/**
 * Query Solana token balance
 */
async function preWarmCrypto() {
  console.log('[PREWARM] 🔥 Pre-warming crypto operations...');
  
  try {
    const start = performance.now();
    
    // Warm up the signing operation by creating and signing dummy transactions
    // This initializes the crypto libraries (keccak256, secp256k1) in memory
    
    // Create a realistic dummy transaction
    const dummyTx = {
      to: '0x0000000000000000000000000000000000000001',
      value: parseEther('0.001'),
      gasLimit: 200000n,
      gasPrice: cachedGasPrice,
      nonce: 0,
      chainId: 56,
      data: '0x'
    };
    
    // Sign multiple dummy transactions to fully warm up crypto
    for (let i = 0; i < 3; i++) {
      const tx = { ...dummyTx, nonce: i };
      const raw = await wallet.signTransaction(tx);
      // Also warm up keccak256 hash computation
      keccak256(raw);
    }
    
    // Additional keccak256 warmup with various data sizes
    keccak256(toUtf8Bytes('warmup'));
    keccak256('0x' + '00'.repeat(64)); // 64 bytes
    keccak256('0x' + '00'.repeat(256)); // 256 bytes
    
    const elapsed = performance.now() - start;
    console.log(`[PREWARM] ✅ Crypto warmed in ${elapsed.toFixed(0)}ms (sign+hash)\n`);
  } catch (e) {
    console.log(`[PREWARM] ⚠️ Crypto pre-warm failed: ${e.message}`);
  }
}

async function preWarmBscRpc() {
  console.log('[PREWARM] 🌐 Pre-warming BSC RPC connections...');
  
  const warmPromises = providers.map(async (p, idx) => {
    try {
      const start = performance.now();
      
      // Make multiple calls to fully establish and stabilize connection
      await p.send('eth_blockNumber', []);
      await p.send('eth_gasPrice', []); // Also warm gas price endpoint
      
      const elapsed = performance.now() - start;
      console.log(`[PREWARM] ✅ RPC #${idx + 1} warmed in ${elapsed.toFixed(0)}ms`);
    } catch (e) {
      console.log(`[PREWARM] ⚠️ RPC #${idx + 1} pre-warm failed: ${e.message}`);
    }
  });
  
  // Warm all RPCs in parallel
  await Promise.allSettled(warmPromises);
  console.log('[PREWARM] ✅ All BSC RPCs ready\n');
}
async function getSolTokenBalance(mint) {
  try {
    if (!SOL_KEYPAIR || SOL_RPC_LIST.length === 0) {
      throw new Error('Solana not configured');
    }
    
    const connection = new Connection(SOL_RPC_LIST[0]);
    const tokenPubkey = new PublicKey(mint);
    const walletPubkey = SOL_KEYPAIR.publicKey;
    
    const tokenAccounts = await connection.getParsedTokenAccountsByOwner(
      walletPubkey,
      { mint: tokenPubkey }
    );
    
    if (tokenAccounts.value.length === 0) {
      return '0';
    }
    
    return tokenAccounts.value[0].account.data.parsed.info.tokenAmount.amount;
    
  } catch (e) {
    console.error('[NIGHT MODE] SOL balance query failed:', e);
    return '0';
  }
}

/**
 * Schedule night mode sells after successful buy
 */
/**
 * Schedule night mode sells after successful buy
 */
/**
 * Schedule night mode sells after successful buy
 */
function scheduleNightModeSells(token, chain, gasGwei, priorityFee, route, sellAfterSeconds = 2) {
  const key = `${chain}:${token}`.toLowerCase();
  
  // Clear any existing timers for this token
  if (nightModeTimers.has(key)) {
    const existing = nightModeTimers.get(key);
    clearTimeout(existing.timer1);
    if (existing.timer2) clearTimeout(existing.timer2);
    nightModeTimers.delete(key);
  }
  
  // Use custom timing or default to 2 seconds
  const delayMs = (sellAfterSeconds || 2) * 1000;
  
  console.log(`[NIGHT MODE] 🌙 Scheduling sell for ${token} on ${chain}`);
  console.log(`[NIGHT MODE] 📅 100% @ ${sellAfterSeconds}s (11 gwei)`);
  
  // Timer: Sell 100% at specified time with 11 gwei
  const timer1 = setTimeout(async () => {
    try {
      console.log(`[NIGHT MODE] ⏰ ${sellAfterSeconds}s elapsed - executing 100% sell`);
      
      if (chain === 'sol') {
        // Solana: Retry up to 3 seconds if no balance
        let balance = 0n;
        const maxRetries = 15; // 15 retries * 200ms = 3 seconds
        
        for (let attempt = 0; attempt <= maxRetries; attempt++) {
          balance = BigInt(await getSolTokenBalance(token));
          
          if (balance > 0n) {
            break; // Found balance, exit retry loop
          }
          
          if (attempt < maxRetries) {
            console.log(`[NIGHT MODE] ⚠️ No balance yet, retrying in 200ms (attempt ${attempt + 1}/${maxRetries})`);
            await new Promise(resolve => setTimeout(resolve, 200));
          }
        }
        
        if (balance > 0n) {
          await sellSolTokens(token, balance.toString(), priorityFee);
        } else {
          console.log('[NIGHT MODE] ❌ No balance after 3s of retries - giving up');
        }
      } else {
        // BNB chain: Retry up to 3 seconds if no balance
        let balance = 0n;
        const maxRetries = 15; // 15 retries * 200ms = 3 seconds
        
        for (let attempt = 0; attempt <= maxRetries; attempt++) {
          balance = await getTokenBalance(token);
          
          if (balance > 0n) {
            break; // Found balance, exit retry loop
          }
          
          if (attempt < maxRetries) {
            console.log(`[NIGHT MODE] ⚠️ No balance yet, retrying in 200ms (attempt ${attempt + 1}/${maxRetries})`);
            await new Promise(resolve => setTimeout(resolve, 200));
          }
        }
        
        if (balance > 0n) {
          // Use the route that was determined during buy
          console.log(`[NIGHT MODE] 🔍 Route (from buy): "${route}" for token ${token}`);
          
          if (route === 'four') {
            // Ungraduated token - use sellUngraduatedToken
            console.log(`[NIGHT MODE] 🔄 Token is UNGRADUATED - using bonding curve sell`);
            await sellUngraduatedToken(token, balance, gasGwei, 1);
          } else {
            // Graduated token - use standard PancakeSwap sell
            console.log(`[NIGHT MODE] 📊 Token is GRADUATED - using PancakeSwap sell (route: ${route})`);
            await sellBnbTokens(token, balance, gasGwei, 1);
          }
        } else {
          console.log('[NIGHT MODE] ❌ No balance after 3s of retries - giving up');
        }
      }
      
      // Cleanup after sell
      nightModeTimers.delete(key);
      console.log(`[NIGHT MODE] ✅ Night mode complete for ${token}`);
      
    } catch (e) {
      console.error('[NIGHT MODE] ❌ 100% sell error:', e);
    }
  }, delayMs);  // Use custom timing
  
  nightModeTimers.set(key, { timer1 });
}
  

/* -------------------------
 * ===== NEW: AUTO ROUTE DECISION (BNB)
 * ------------------------- */

// simple in-memory cache to avoid spamming getPair every click
const graduationCache = new Map();

/**
 * Check if a token is Binance-exclusive by looking for the special name pattern
 * Binance-exclusive tokens have names like "Binance-Peg Bitcoin (BSC)" or similar
 */
async function isBinanceExclusive(tokenAddr) {
  try {
    // ERC20 name() function
    const nameAbi = ['function name() view returns (string)'];
    const nameIface = new Interface(nameAbi);
    const dataName = nameIface.encodeFunctionData('name', []);
    const rawName = await provider.call({ to: tokenAddr, data: dataName });
    const [name] = nameIface.decodeFunctionResult('name', rawName);
    
    // Check if name contains "Binance" or "BSC-" or similar patterns
    const nameLower = (name || '').toLowerCase();
    return nameLower.includes('binance') || nameLower.startsWith('bsc-');
  } catch {
    return false;
  }
}

/**
 * Decide which venue to use when mode === 'auto'.
 * Returns 'binance-exclusive', 'pancake', or 'four'.
 *
 * - If no Pancake pair exists for WBNB/token -> 'four'
 * - If pair exists but WBNB liquidity is tiny (< ~0.1 BNB) -> 'four'
 * - If pair exists and token is Binance-exclusive -> 'binance-exclusive'
 * - On any error -> 'pancake' (preserves legacy behavior)
 */
async function decideAutoRoute(tokenAddr) {
  const key = tokenAddr.toLowerCase();
  const cached = graduationCache.get(key);
  const now = Date.now();
  // 15s cache window
  if (cached && (now - cached.ts) < 15000) {
    return cached.mode;
  }

  let route = 'pancake';

  try {
    const WBNB = normalize(WBNB_LC);

    // 1) Does a WBNB pair exist on Pancake factory?
    const dataGetPair = PCS_IFACE.encodeFunctionData('getPair', [WBNB, tokenAddr]);
    const rawPair = await provider.call({ to: PCS_FACTORY, data: dataGetPair });
    const [pair] = PCS_IFACE.decodeFunctionResult('getPair', rawPair);

    if (!pair || pair.toLowerCase() === ZERO_ADDRESS.toLowerCase()) {
      // no pair at all -> treat as ungraduated (bonding curve)
      route = 'four';
    } else {
      // Pair exists - check if it's Binance-exclusive first
      const isBinance = await isBinanceExclusive(tokenAddr);
      if (isBinance) {
        route = 'binance-exclusive';
      } else {
        // check WBNB reserves to filter out dust pairs
        try {
          const dataToken0 = PAIR_IFACE.encodeFunctionData('token0', []);
          const dataToken1 = PAIR_IFACE.encodeFunctionData('token1', []);
          const [token0] = PAIR_IFACE.decodeFunctionResult(
            'token0',
            await provider.call({ to: pair, data: dataToken0 })
          );
          const [token1] = PAIR_IFACE.decodeFunctionResult(
            'token1',
            await provider.call({ to: pair, data: dataToken1 })
          );

          const dataReserves = PAIR_IFACE.encodeFunctionData('getReserves', []);
          const [reserve0, reserve1] = PAIR_IFACE.decodeFunctionResult(
            'getReserves',
            await provider.call({ to: pair, data: dataReserves })
          );

          let wbnbReserve = 0n;
          if (token0.toLowerCase() === WBNB.toLowerCase()) {
            wbnbReserve = reserve0;
          } else if (token1.toLowerCase() === WBNB.toLowerCase()) {
            wbnbReserve = reserve1;
          }

          // Rough threshold: if < 0.1 BNB in the pair, treat as "not really graduated"
          const threshold = parseEther('0.1');
          if (wbnbReserve < threshold) {
            route = 'four';
          }
        } catch {
          // if reserve checks fail, just keep 'pancake'
        }
      }
    }
  } catch {
    // any error: fallback to pancake mode to preserve old behavior
    route = 'pancake';
  }

  graduationCache.set(key, { mode: route, ts: now });
  return route;
}

/* -------------------------
 * ===== NEW: OPTIMIZED FETCH WITH TIMEOUT =====
 * ------------------------- */

async function fetchWithTimeout(url, options = {}, timeoutMs = FETCH_TIMEOUT_MS) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  
  try {
    // Add agent based on protocol
    const isHttps = url.startsWith('https://');
    const fetchOptions = {
      ...options,
      signal: controller.signal,
      agent: isHttps ? httpsAgent : httpAgent
    };
    
    const response = await fetch(url, fetchOptions);
    clearTimeout(timeoutId);
    return response;
  } catch (error) {
    clearTimeout(timeoutId);
    if (error.name === 'AbortError') {
      throw new Error(`Request timeout after ${timeoutMs}ms`);
    }
    throw error;
  }
}

/* -------------------------
 * SOLANA CORE SWAP LOGIC
 * PumpPortal Lightning path - OPTIMIZED
 * ------------------------- */

async function handleSolSwapInternal(reqBody) {
  if (!SOLANA_ENABLED) {
    throw new Error('Solana not configured (no PumpPortal key or no RPC)');
  }
  if (!PUMPPORTAL_API_KEY) {
    throw new Error('PumpPortal API key missing (PUMPPORTAL_API_KEY)');
  }

  const tStart = performance.now();
  const timingBreakdown = {};

  // Parse input
  const tParseStart = performance.now();
  const mint         = String(reqBody.token || '').trim();
  const amountSol    = Number(reqBody.amount ?? reqBody.amountSOL ?? 0);
  const slippagePct  = Number(reqBody.slippage ?? 10);          // %
  const priorityFee  = Number(reqBody.priorityFee ?? 0.00005);  // SOL tip
  const pool         = String(reqBody.pool || 'auto');

  if (!mint)      { throw new Error('token (mint) required'); }
  if (!amountSol) { throw new Error('amount required (in SOL)'); }
  timingBreakdown.parseMs = Math.round(performance.now() - tParseStart);

  // Build form body
  const tBuildStart = performance.now();
  const formBody = new URLSearchParams({
    action: 'buy',
    mint,
    amount: String(amountSol),
    denominatedInSol: 'true',
    slippage: String(slippagePct),
    priorityFee: String(priorityFee),
    pool,
    skipPreflight: 'true',
    jitoOnly: 'false'
  });
  timingBreakdown.buildFormMs = Math.round(performance.now() - tBuildStart);

  const tradeUrl = `https://pumpportal.fun/api/trade?api-key=${encodeURIComponent(PUMPPORTAL_API_KEY)}`;
  console.log(tradeUrl)

  // ===== OPTIMIZED FETCH WITH TIMEOUT & AGENT =====
  console.log('[SOL] Sending PumpPortal request...');
  const tReqStart = performance.now();
  
  let pumpRes;
  try {
    pumpRes = await fetchWithTimeout(tradeUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Connection': 'keep-alive'  // hint to keep connection alive
      },
      body: formBody.toString()
    });
  } catch (fetchError) {
    const tReqEnd = performance.now();
    timingBreakdown.requestFailedMs = Math.round(tReqEnd - tReqStart);
    console.error('[SOL] PumpPortal request failed:', fetchError.message);
    throw new Error(`PumpPortal fetch failed: ${fetchError.message}`);
  }
  
  const tReqEnd = performance.now();
  timingBreakdown.requestMs = Math.round(tReqEnd - tReqStart);
  console.log(`[SOL] PumpPortal responded in ${timingBreakdown.requestMs}ms`);

  if (!pumpRes.ok) {
    throw new Error(`PumpPortal HTTP ${pumpRes.status}`);
  }

  const tJsonStart = performance.now();
  const pumpJson = await pumpRes.json();
  timingBreakdown.jsonParseMs = Math.round(performance.now() - tJsonStart);

  // PumpPortal success typically includes { signature: "..." } or { sig: "..." }
  const sig =
    pumpJson.signature ||
    pumpJson.sig ||
    pumpJson.txSignature ||
    pumpJson.txSignatureBase58 ||
    pumpJson.txid ||
    pumpJson.tx ||
    null;

  const tEnd = performance.now();
  const totalMs = Math.round(tEnd - tStart);
  timingBreakdown.totalMs = totalMs;

  if (!sig) {
    // no signature: return raw + error reason
    console.warn('[SOL] PumpPortal returned no signature', pumpJson);
    return {
      ok: false,
      error: pumpJson.error || pumpJson.message || 'no signature returned',
      timing: timingBreakdown,
      raw: pumpJson
    };
  }

  // success
  console.log(`[SOL] ✅ Success! Signature: ${sig} (total: ${totalMs}ms)`);
  return {
    ok: true,
    sig,
    hash: sig,
    signature: sig,
    mode: 'pumpportal',
    timing: timingBreakdown,
    raw: pumpJson
  };
}

/* -------------------------
 * ===== NEW: PRE-WARM PUMPPORTAL CONNECTION =====
 * ------------------------- */

async function preWarmPumpPortal() {
  if (!PUMPPORTAL_API_KEY) {
    console.log('[PREWARM] Skipping PumpPortal pre-warm (no API key)');
    return;
  }
  
  console.log('[PREWARM] Pre-warming PumpPortal connection...');
  try {
    // Make a minimal request to establish connection
    const testUrl = `https://pumpportal.fun/api/trade?api-key=${encodeURIComponent(PUMPPORTAL_API_KEY)}`;
    console.log(testUrl);
    
    const response = await fetchWithTimeout(testUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Connection': 'keep-alive'
      },
      body: new URLSearchParams({
        action: 'buy',
        mint: 'pump', // dummy - will fail but establishes connection
        amount: '0.001',
        denominatedInSol: 'true',
        slippage: '10',
        priorityFee: '0.00001',
        pool: 'pump',
        skipPreflight: 'true',
        jitoOnly: 'false'
      }).toString()
    }, 3000); // shorter timeout for prewarm
    
    // We expect this to fail, but it establishes the connection
    await response.json().catch(() => {});
    console.log('[PREWARM] ✅ PumpPortal connection established');
  } catch (e) {
    console.log('[PREWARM] ⚠️ Pre-warm failed (not critical):', e.message);
  }
}

/* -------------------------
 * ROUTES
 * ------------------------- */

// Health: returns BSC + Solana readiness
app.get('/health', async (_req, res) => {
  try {
    const addr = await addrPromise;
    ok(res, {
      ok: true,
      evm: {
        address: addr,
        rpcCount: RPCS.length,
        gasPriceWei: cachedGasPrice.toString(),
        gasLastUpdated,
      },
      sol: {
        enabled: SOLANA_ENABLED,
        pubkey: SOL_KEYPAIR ? SOL_KEYPAIR.publicKey.toBase58() : null,
        hasPumpPortalKey: !!PUMPPORTAL_API_KEY,
        rpcCount: SOL_RPC_LIST.length
      }
    });
  } catch (e) {
    err(res, e?.message || String(e), 500);
  }
});

// ════════════════════════════════════════════════════════════════
// BSC /swap - OPTIMIZED
// ════════════════════════════════════════════════════════════════
app.post('/swap', async (req, res) => {
  const t0 = performance.now();
  
  try {
    if (API_TOKEN) {
      const hdr = req.get('x-api-token') || '';
      if (hdr !== API_TOKEN) return err(res, 'unauthorized', 401);
    }

    let { token, amountBNB, gasGwei, router, dryRun, mode, slippage, expectedTokens } = req.body || {};
    
    if (!token)     return err(res, 'token required');
    if (!amountBNB) return err(res, 'amountBNB required');

    // Normalize & basics
    const TOKEN    = normalize(token);
    const WBNB     = normalize(WBNB_LC);
    const amountIn = parseEther(String(amountBNB));
    const toAddr   = await addrPromise;

    // ===== SLIPPAGE CALCULATION =====
    // If slippage is set but expectedTokens not provided, fetch from PancakeSwap
    const slippagePct = slippage !== undefined && slippage !== null ? Number(slippage) : 0;
    
    if (slippagePct > 0 && !expectedTokens) {
      console.log(`💧 [SIGNER] Slippage ${slippagePct}% set, fetching expectedTokens...`);
      expectedTokens = await getExpectedTokensOut(TOKEN, Number(amountBNB));
      if (expectedTokens) {
        console.log(`💧 [SIGNER] Will use slippage protection: ${slippagePct}%`);
      } else {
        console.log(`💧 [SIGNER] Quote fetch failed, proceeding without slippage protection`);
      }
    }
    
    // Calculate minAmountOut based on slippage and expectedTokens
    // If slippage or expectedTokens not provided, use 0n (backward compatible)
    const calculateMinAmountOut = (expectedTokens, slippagePct) => {
      if (!expectedTokens || !slippagePct) return 0n;
      try {
        const expected = BigInt(expectedTokens);
        const slippageMultiplier = 10000n - BigInt(Math.floor(slippagePct * 100));
        const minOut = (expected * slippageMultiplier) / 10000n;
        console.log(`[SLIPPAGE] Expected: ${expectedTokens}, Slippage: ${slippagePct}%, MinOut: ${minOut.toString()}`);
        return minOut;
      } catch (e) {
        console.warn('[SLIPPAGE] Calculation failed, using 0n:', e.message);
        return 0n;
      }
    };
    
    const minAmountOut = calculateMinAmountOut(expectedTokens, slippagePct);

    // Normalise mode: default 'pancake' to preserve legacy behavior
    let routeMode = String(mode || 'pancake').toLowerCase();
    if (routeMode !== 'pancake' && routeMode !== 'four' && routeMode !== 'auto' && routeMode !== 'binance-exclusive') {
      routeMode = 'pancake';
    }

    // If 'auto', decide based on Pancake factory; otherwise respect explicit choice
    let chosenRoute = routeMode;
    if (routeMode === 'auto') {
      chosenRoute = await decideAutoRoute(TOKEN);
    }
    let txTo;
    let data;

    if (chosenRoute === 'four') {
      // ===== 4meme "ungraduated" bonding curve via buyMemeToken =====
      const fundsWei   = amountIn;

      data = MEME_IFACE.encodeFunctionData(
        'buyMemeToken',
        [TOKEN_MANAGER, TOKEN, toAddr, fundsWei, minAmountOut]
      );
      txTo = MEME_ROUTER;
    } else if (chosenRoute === 'binance-exclusive') {
      // ===== Binance-exclusive router path =====
      const ROUTER = ROUTER_BINANCE_EXCLUSIVE;
      const path = [WBNB, TOKEN];
      const deadline = BigInt(Math.floor(Date.now() / 1000) + 20 * 60);

      data = IFACE.encodeFunctionData(
        'swapExactETHForTokensSupportingFeeOnTransferTokens',
        [minAmountOut, path, toAddr, deadline]
      );
      txTo = ROUTER;
    } else {
      // ===== Pancake router path (existing behavior) =====
      const ROUTER = router ? normalize(router) : normalize(ROUTER_DEFAULT_LC);
      const path = [WBNB, TOKEN];
      const deadline = BigInt(Math.floor(Date.now() / 1000) + 20 * 60);

      data = IFACE.encodeFunctionData(
        'swapExactETHForTokensSupportingFeeOnTransferTokens',
        [minAmountOut, path, toAddr, deadline]
      );
      txTo = ROUTER;
    }

    if (dryRun) {
      const t1 = performance.now();
      return ok(res, {
        ok: true,
        dryRun: true,
        route: chosenRoute,
        dataLen: data.length,
        elapsedMs: Math.round(t1 - t0)
      });
    }

    // Gas price: prefer user override, else cached
    const gasPrice = gasGwei ? parseUnits(String(gasGwei), 'gwei') : cachedGasPrice;

    // Hardcode a safe gasLimit to skip estimateGas
    const GAS_LIMIT = 300000n;

    // Take nonce from local cache to skip getTransactionCount each time
    const nonce = await takeNonce();

    // Build raw tx directly
    const tx = {
      chainId: 56,
      to: txTo,
      value: amountIn,
      data,
      gasPrice,
      gasLimit: GAS_LIMIT,
      nonce,
      type: 0
    };

    // Sign transaction
    const raw = await wallet.signTransaction(tx);
    
    // Compute hash directly from raw bytes (much faster than Transaction.from)
    const hash = keccak256(raw);

    // Broadcast aggressively across RPCs
    try {
      await broadcastRawTxToAll(raw);

markBscActivity();
    } catch (broadcastErr) {
      // roll back nonce on total failure so next attempt doesn't skip
      nextNonce = Math.min(nextNonce ?? (nonce + 1), nonce);
      const msg = broadcastErr?.reason || broadcastErr?.message || String(broadcastErr);
      return err(res, `broadcast failed: ${msg}`, 502);
    }

    const t1 = performance.now();

    // ⭐ NIGHT MODE: Schedule sells if enabled (AFTER successful broadcast)
    if (req.body.nightMode) {
      setImmediate(() => {
        scheduleNightModeSells(
          TOKEN,
          'bnb',
          gasGwei || Number(cachedGasPrice) / 1e9,
          undefined,
          chosenRoute,  // Pass the route we already determined
          req.body.sellAfterSeconds  // Pass custom timing
        );
      });
    }

    return ok(res, {
      ok: true,
      hash,
      mode: 'broadcast-only',
      route: chosenRoute,
      rpcUsed: RPCS.length,
      gasPriceGwei: Number(gasPrice) / 1e9,
      gasLimit: Number(GAS_LIMIT),
      elapsedMs: Math.round(t1 - t0),
      nightMode: !!req.body.nightMode
    });

  } catch (e) {
    const msg = e?.reason || e?.shortMessage || e?.message || String(e);
    return err(res, msg, 500);
  }
});

// SOL /swapSol (SOL -> token via PumpPortal Lightning API) - FAST PATH
app.post('/swapSol', async (req, res) => {
  const t0 = performance.now();

  try {
    if (API_TOKEN) {
      const hdr = req.get('x-api-token') || '';
      if (hdr !== API_TOKEN) {
        return err(res, 'unauthorized', 401);
      }
    }

    let {
      mint,
      token,
      amountSOL,
      amount,
      slippage,
      priorityFee,
      pool,
    } = req.body || {};

    // map aliases
    mint      = mint      || token;
    amountSOL = amountSOL || amount;

    if (!mint || String(mint).trim() === '') {
      return err(res, 'mint (token address) required', 400);
    }
    if (!amountSOL) {
      return err(res, 'amountSOL required', 400);
    }

    const slipPct   = (slippage !== undefined && slippage !== null && slippage !== '')
      ? Number(slippage)
      : 10;
    const tipFee    = (priorityFee !== undefined && priorityFee !== null && priorityFee !== '')
      ? Number(priorityFee)
      : 0.00005;
    const whichPool = pool || 'auto';

    if (!PUMPPORTAL_API_KEY) {
      return err(res, 'PumpPortal API key missing (PUMPPORTAL_API_KEY)', 500);
    }

    const formBody = new URLSearchParams({
      action: 'buy',
      mint: String(mint).trim(),
      amount: String(amountSOL),
      denominatedInSol: 'true',
      slippage: String(slipPct),
      priorityFee: String(tipFee),
      pool: whichPool,
      skipPreflight: 'true',
      jitoOnly: 'false'
    });

    const tradeUrl =`https://pumpportal.fun/api/trade?api-key=${encodeURIComponent(PUMPPORTAL_API_KEY)}`;
    console.log(tradeUrl);

    const tReq0 = performance.now();
    let pumpRes;
    try {
      pumpRes = await fetchWithTimeout(tradeUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'Connection': 'keep-alive'
        },
        body: formBody.toString()
      });
    } catch (fetchErr) {
      const fetchMs = Math.round(performance.now() - tReq0);
      return err(res, `PumpPortal fetch failed (${fetchMs}ms): ${fetchErr.message}`, 502);
    }
    const tReq1 = performance.now();
    const reqMs = Math.round(tReq1 - tReq0);

    if (!pumpRes.ok) {
      const txt = await pumpRes.text().catch(() => '(no body)');
      return err(
        res,
        `PumpPortal HTTP ${pumpRes.status} after ${reqMs}ms: ${txt.slice(0,200)}`,
        502
      );
    }

    let pumpJson;
    try {
      pumpJson = await pumpRes.json();
    } catch (e) {
      return err(res, `invalid JSON from PumpPortal after ${reqMs}ms`, 502);
    }

    const sig =
      pumpJson.signature ||
      pumpJson.sig ||
      pumpJson.txSignature ||
      pumpJson.txSignatureBase58 ||
      pumpJson.txid ||
      pumpJson.tx ||
      null;

    const t1 = performance.now();
    const totalMs = Math.round(t1 - t0);

    if (!sig) {
      return ok(res, {
        ok: false,
        chain: 'solana',
        error: pumpJson.error || pumpJson.message || 'no signature returned',
        timing: {
          totalMs,
          pumpRequestMs: reqMs
        },
        raw: pumpJson
      });
    }
    markSolActivity();

    // ⭐ NIGHT MODE: Schedule sells if enabled
    if (req.body.nightMode) {
      const mintAddr = String(mint).trim();
      setImmediate(() => {
        scheduleNightModeSells(
          mintAddr,
          'sol',
          undefined,
          tipFee,
          undefined,  // Solana doesn't have route concept
          req.body.sellAfterSeconds  // Pass custom timing
        );
      });
    }

    return ok(res, {
      ok: true,
      chain: 'solana',
      mode: 'pumpportal',
      sig,
      hash: sig,
      signature: sig,
      timing: {
        totalMs,
        pumpRequestMs: reqMs
      },
      raw: pumpJson,
      nightMode: !!req.body.nightMode
    });

  } catch (e) {
    return err(res, e?.message || String(e), 500);
  }
});

/* -------------------------
 * START SERVER
 * ------------------------- */
// Keep crypto warm with periodic dummy signing
async function keepAliveCrypto() {
  try {
    const dummyTx = {
      to: '0x0000000000000000000000000000000000000001',
      value: parseEther('0.001'),
      gasLimit: 200000n,
      gasPrice: cachedGasPrice,
      nonce: 0,
      chainId: 56,
      data: '0x'
    };
    
    const raw = await wallet.signTransaction(dummyTx);
    keccak256(raw); // Also warm keccak256
    console.log('[KEEPALIVE] Crypto warmed');
  } catch (e) {
    console.log(`[KEEPALIVE] Crypto warmup: ${e.message}`);
  }
}

async function keepAliveBscRpc() {
  const timeSinceActivity = Date.now() - bscLastActivity;
  if (timeSinceActivity < KEEPALIVE_INTERVAL_MS * 0.8) return; // Skip if recent activity

  try {
    const start = performance.now();
    const results = await Promise.allSettled(
      providers.map(p => p.send('eth_blockNumber', []))
    );
    const elapsed = performance.now() - start;
    const successCount = results.filter(r => r.status === 'fulfilled').length;
    
    console.log(`[KEEPALIVE] BSC RPCs: ${successCount}/${providers.length} alive (${elapsed.toFixed(0)}ms)`);
    bscLastActivity = Date.now();
  } catch (e) {
    console.log(`[KEEPALIVE] BSC ping error: ${e.message}`);
  }
}

// Keep PumpPortal connection warm
// DISABLED: Not needed, connection stays warm from actual trades
/*
async function keepAlivePumpPortal() {
  if (!PUMPPORTAL_API_KEY) return;
  
  const timeSinceActivity = Date.now() - solLastActivity;
  if (timeSinceActivity < KEEPALIVE_INTERVAL_MS * 0.8) return;

  try {
    const start = performance.now();
    const tradeUrl = `https://pumpportal.fun/api/trade?api-key=${encodeURIComponent(PUMPPORTAL_API_KEY)}`;
    
    const response = await fetchWithTimeout(tradeUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Connection': 'keep-alive'
      },
      body: new URLSearchParams({
        action: 'buy',
        mint: 'keepalive',
        amount: '0.001',
        denominatedInSol: 'true',
        slippage: '10',
        priorityFee: '0.00001',
        pool: 'pump',
        skipPreflight: 'true',
        jitoOnly: 'false'
      }).toString()
    }, 3000);
    
    await response.json().catch(() => {});
    const elapsed = performance.now() - start;
    
    console.log(`[KEEPALIVE] PumpPortal alive (${elapsed.toFixed(0)}ms)`);
    solLastActivity = Date.now();
  } catch (e) {
    console.log(`[KEEPALIVE] PumpPortal ping: ${e.message}`);
  }
}
*/

// Combined keepalive
async function keepAliveAll() {
  await Promise.allSettled([
    keepAliveCrypto(),
    keepAliveBscRpc()
    // PumpPortal keepalive removed - not needed, connection stays warm from actual trades
  ]);
}

// Activity markers (to skip unnecessary pings)
function markBscActivity() {
  bscLastActivity = Date.now();
}

function markSolActivity() {
  solLastActivity = Date.now();
}

// ═══════════════════════════════════════════════════════════════
// 🚀 WebSocket Server Setup (Ultra-Low Latency ~2-3ms)
// ═══════════════════════════════════════════════════════════════

const WS_PORT = Number(process.env.WS_PORT || 8788);

// WebSocket server for ultra-fast buy requests
const wss = new WebSocketServer({ 
  port: WS_PORT,
  host: '127.0.0.1'
});

let wsConnectionCount = 0;

wss.on('connection', (ws, req) => {
  wsConnectionCount++;
  const clientId = wsConnectionCount;
  console.log(`[WS] Client #${clientId} connected from ${req.socket.remoteAddress}`);
  
  ws.on('message', async (data) => {
    const t0 = performance.now();
    let msg = null; // Declare outside try for error handler access
    
    try {
      msg = JSON.parse(data.toString());
      
      // Handle different message types
      if (msg.type === 'swap' || msg.type === 'buy') {
        // BSC swap request
        const reqBody = msg.payload;
        const TOKEN = String(reqBody.token || '').trim();
        const amountBNB = Number(reqBody.amountBNB || 0);
        
        if (!TOKEN || !amountBNB) {
          ws.send(JSON.stringify({
            id: msg.id,
            ok: false,
            error: 'Missing token or amountBNB',
            elapsedMs: Math.round(performance.now() - t0)
          }));
          return;
        }
        
        // Use the existing swap logic
        const gasGwei = reqBody.gasGwei;
        const dryRun = !!reqBody.dryRun;
        
        if (dryRun) {
          // Quick dry run response
          ws.send(JSON.stringify({
            id: msg.id,
            ok: true,
            hash: '0xdryrun',
            mode: 'dry-run',
            elapsedMs: Math.round(performance.now() - t0)
          }));
          return;
        }
        
        // Get gas price
        let gasPrice = gasGwei ? parseUnits(String(gasGwei), 'gwei') : cachedGasPrice;
        
        // ===== SLIPPAGE CALCULATION FOR WEBSOCKET =====
        const slippage = reqBody.slippage !== undefined && reqBody.slippage !== null ? Number(reqBody.slippage) : 0;
        let expectedTokens = reqBody.expectedTokens;
        
        // If slippage is set but expectedTokens not provided, fetch from PancakeSwap
        if (slippage > 0 && !expectedTokens) {
          console.log(`💧 [WS-SIGNER] Slippage ${slippage}% set, fetching expectedTokens...`);
          
          // Use smart quote fetching with route hint from reqBody.mode
          const routeHint = reqBody.mode; // 'four' or 'pancake' or undefined for auto-detect
          expectedTokens = await getExpectedTokensOutSmart(TOKEN, Number(amountBNB), routeHint);
          
          if (expectedTokens) {
            console.log(`💧 [WS-SIGNER] Will use slippage protection: ${slippage}%`);
          } else {
            console.log(`💧 [WS-SIGNER] Quote fetch failed, proceeding without slippage protection`);
          }
        }
        
        let minAmountOut = 0n;
        if (expectedTokens && slippage > 0) {
          try {
            const expected = BigInt(expectedTokens);
            const slippageMultiplier = 10000n - BigInt(Math.floor(slippage * 100));
            minAmountOut = (expected * slippageMultiplier) / 10000n;
            console.log(`[WS-SLIPPAGE] Expected: ${expectedTokens}, Slippage: ${slippage}%, MinOut: ${minAmountOut.toString()}`);
          } catch (e) {
            console.warn('[WS-SLIPPAGE] Calculation failed, using 0n:', e.message);
            minAmountOut = 0n;
          }
        }
        
        // Get nonce
        const nonce = await takeNonce();
        
        // Determine route
        const chosenRoute = reqBody.mode === 'four' ? 'four' : 'pancake';
        const ROUTER = chosenRoute === 'four' ? MEME_ROUTER : normalize(ROUTER_DEFAULT_LC);
        const WBNB = normalize(WBNB_LC);
        const deadline = Math.floor(Date.now() / 1000) + (reqBody.deadline || 1200);
        const toAddr = await addrPromise;
        const GAS_LIMIT = reqBody.gasLimit || 300000;
        
        let data, value;
        if (chosenRoute === 'four') {
          data = MEME_IFACE.encodeFunctionData('buyMemeToken', [
            TOKEN_MANAGER,
            TOKEN,
            toAddr,
            parseEther(String(amountBNB)),
            minAmountOut
          ]);
          value = parseEther(String(amountBNB));
        } else {
          const path = [WBNB, TOKEN];
          data = IFACE.encodeFunctionData('swapExactETHForTokensSupportingFeeOnTransferTokens', [
            minAmountOut, path, toAddr, deadline
          ]);
          value = parseEther(String(amountBNB));
        }
        
        const tx = {
          to: ROUTER,
          value,
          gasPrice,
          gasLimit: BigInt(GAS_LIMIT),
          nonce,
          data,
          chainId: 56,
          type: 0
        };
        
        // Sign transaction
        const raw = await wallet.signTransaction(tx);
        
        const hash = keccak256(raw);
        
        // Broadcast
        try {
          await broadcastRawTxToAll(raw);
          markBscActivity();
        } catch (broadcastErr) {
          nextNonce = Math.min(nextNonce ?? (nonce + 1), nonce);
          ws.send(JSON.stringify({
            id: msg.id,
            ok: false,
            error: `broadcast failed: ${broadcastErr.message}`,
            elapsedMs: Math.round(performance.now() - t0)
          }));
          return;
        }
        
        const elapsedMs = Math.round(performance.now() - t0);
        
        // Send success response
        ws.send(JSON.stringify({
          id: msg.id,
          ok: true,
          hash,
          mode: 'broadcast-only',
          route: chosenRoute,
          rpcUsed: RPCS.length,
          gasPriceGwei: Number(gasPrice) / 1e9,
          gasLimit: Number(GAS_LIMIT),
          elapsedMs,
          nightMode: !!reqBody.nightMode
        }));
        
        // Night mode scheduling
        if (reqBody.nightMode) {
          setImmediate(() => {
            scheduleNightModeSells(
              TOKEN, 
              'bnb', 
              gasGwei || Number(cachedGasPrice) / 1e9, 
              undefined, 
              chosenRoute,
              reqBody.sellAfterSeconds  // Pass custom timing
            );
          });
        }
        
      } else if (msg.type === 'swapSol' || msg.type === 'sol') {
        // Solana swap via PumpPortal
        const reqBody = msg.payload;
        
        if (!PUMPPORTAL_API_KEY) {
          ws.send(JSON.stringify({
            id: msg.id,
            ok: false,
            error: 'PumpPortal not configured',
            elapsedMs: Math.round(performance.now() - t0)
          }));
          return;
        }
        
        // Use existing SOL swap logic (simplified for WebSocket)
        const mint = String(reqBody.token || reqBody.mint || '').trim();
        const amount = Number(reqBody.amount || 0);
        
        if (!mint || !amount) {
          ws.send(JSON.stringify({
            id: msg.id,
            ok: false,
            error: 'Missing mint or amount',
            elapsedMs: Math.round(performance.now() - t0)
          }));
          return;
        }
        
        // Call PumpPortal (simplified - use your existing logic)
        const tradeUrl = `https://pumpportal.fun/api/trade?api-key=${encodeURIComponent(PUMPPORTAL_API_KEY)}`;
        const body = new URLSearchParams({
          action: 'buy',
          mint,
          amount: String(amount),
          denominatedInSol: 'true',
          slippage: String(reqBody.slippage || 10),
          priorityFee: String(reqBody.priorityFee || 0.0001),
          pool: reqBody.pool || 'pump'
        });
        
        const pumpRes = await fetchWithTimeout(tradeUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: body.toString()
        }, 10000);
        
        const pumpJson = await pumpRes.json();
        const sig = pumpJson.signature || pumpJson.sig || null;
        
        markSolActivity();
        
        ws.send(JSON.stringify({
          id: msg.id,
          ok: !!sig,
          sig,
          hash: sig,
          signature: sig,
          chain: 'solana',
          mode: 'pumpportal',
          elapsedMs: Math.round(performance.now() - t0),
          raw: pumpJson
        }));
        
      } else if (msg.type === 'ping') {
        // Heartbeat
        ws.send(JSON.stringify({ 
          id: msg.id, 
          type: 'pong', 
          timestamp: Date.now() 
        }));
        
      } else {
        ws.send(JSON.stringify({
          id: msg.id,
          ok: false,
          error: 'Unknown message type',
          elapsedMs: Math.round(performance.now() - t0)
        }));
      }
      
    } catch (e) {
      console.error('[WS] Error handling message:', e);
      ws.send(JSON.stringify({
        id: msg?.id || 0,
        ok: false,
        error: e.message,
        elapsedMs: Math.round(performance.now() - t0)
      }));
    }
  });
  
  ws.on('close', () => {
    console.log(`[WS] Client #${clientId} disconnected`);
  });
  
  ws.on('error', (err) => {
    console.error(`[WS] Client #${clientId} error:`, err.message);
  });
});

wss.on('error', (err) => {
  console.error('[WS] Server error:', err);
});

// ═══════════════════════════════════════════════════════════════
// HTTP Server (Legacy/Fallback)
// ═══════════════════════════════════════════════════════════════

app.listen(PORT, '127.0.0.1', async () => {
  console.log(`\n${'='.repeat(60)}`);
  console.log(`🚀 OPTIMIZED Signer listening on http://127.0.0.1:${PORT}`);
  console.log(`🔌 WebSocket Server listening on ws://127.0.0.1:${WS_PORT}`);
  console.log(`${'='.repeat(60)}`);
  console.log('Wallet (BSC):', await addrPromise);
  console.log('BSC RPC endpoints:', RPCS.join(', '));
  console.log('Solana pubkey (local signer):', SOL_KEYPAIR ? SOL_KEYPAIR.publicKey.toBase58() : '(none)');
  console.log('PumpPortal Lightning enabled:', !!PUMPPORTAL_API_KEY);
  console.log('Solana RPC endpoints:', SOL_RPC_LIST.join(', ') || '(none)');
  console.log(`Fetch timeout: ${FETCH_TIMEOUT_MS}ms`);
  console.log(`HTTP Agent: keepAlive enabled (maxSockets: 10)`);
  console.log(`📊 Timing logs: http://127.0.0.1:${PORT}/timing`);
  console.log(`📁 Log file: ${timingLogFile}`);
  console.log(`${'='.repeat(60)}\n`);
  
  console.log('[KEEPALIVE] Starting auto-keepalive (every 2 minutes)');
  setInterval(keepAliveAll, KEEPALIVE_INTERVAL_MS);
  console.log('[KEEPALIVE] ✅ Active\n');
  
  console.log('✅ Server ready - all connections warmed!\n');
});

// optional export if you ever want to import this helper somewhere else
export async function handleSolSwap(reqBody) {
  return handleSolSwapInternal(reqBody);
}
