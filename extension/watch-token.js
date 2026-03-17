// watch-token.js
// Four.meme TokenCreate watcher + "special buy" microservice (BSC).
//
// Uses the SAME TokenCreate parsing logic as your minimal working watcher,
// and the special-buy / multi-wallet split logic from your previous version.
//
// Modes:
//   1) NEXT COIN WINS
//      POST /special-buy { "amountBNB": 0.005 }
//      → First TokenCreate from the managers will trigger the buy.
//
//   2) MATCH BY NAME / SYMBOL
//      POST /special-buy { "amountBNB": 0.005, "name": "CZ BOOK" }
//      or
//      POST /special-buy { "amountBNB": 0.01, "symbol": "CZBIOG" }
//      → First TokenCreate whose name/symbol matches will trigger.
//
//   3) (OPTIONAL) GAS OVERRIDE
//      POST /special-buy { "amountBNB": 0.01, "gasGwei": 11, ... }
//      → Buys use gasPrice = 11 gwei via signer.
//
// Requirements:
//   - Node 18+
//   - npm i ethers@6
//
// Signers:
//   - SIGNER1_SWAP (default http://127.0.0.1:8787/swap)
//   - SIGNER2_SWAP (default http://127.0.0.1:8788/swap)
import fs from "node:fs";
import process from "node:process";

// ---- Optional .env loader (same pattern as your other scripts) ----
if (fs.existsSync(".env")) {
  for (const line of fs.readFileSync(".env", "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (m) {
      let v = m[2];
      if (
        (v.startsWith('"') && v.endsWith('"')) ||
        (v.startsWith("'") && v.endsWith("'"))
      ) {
        v = v.slice(1, -1);
      }
      process.env[m[1]] = v;
    }
  }
}

import { WebSocketProvider, Interface } from "ethers";
import http from "node:http";

// ---------------------------------------------------------------------------
// CONFIG
// ---------------------------------------------------------------------------

const BSC_WS =
  process.env.BSC_WS ||
  "wss://bnb-mainnet.g.alchemy.com/v2/WRx1-3_oomCf6xDPAV6HA"; // replace with faster WSS if you have one

const TOKEN_MANAGER_V2 = "0x5c952063c7fc8610FFDB798152D69F0B9550762b";
const TOKEN_MANAGER_V1 = "0xEC4549caDcE5DA21Df6E6422d448034B5233bFbC";

const SIGNER1_SWAP =
  process.env.SIGNER1_SWAP || "http://127.0.0.1:8787/swap";
const SIGNER2_SWAP =
  process.env.SIGNER2_SWAP || "http://127.0.0.1:8788/swap";
const SIGNER1_TOKEN = process.env.SIGNER1_TOKEN || "";
const SIGNER2_TOKEN = process.env.SIGNER2_TOKEN || "";
const SERVICE_PORT = Number(process.env.SPECIAL_BUY_PORT || 8790);

// Default TOTAL amount across both wallets if /special-buy doesn't specify
const DEFAULT_AMOUNT_BNB = 1;
const HARD_CODED_NAME = "CZ自传"; //

// ---------------------------------------------------------------------------
// ABI FRAGMENTS — same logic as your working minimal watcher
// ---------------------------------------------------------------------------

const TOKEN_CREATE_FRAGS = [
  "TokenCreate(address,address,uint256,string,string,uint256,uint256)",
  "TokenCreate(address,address,uint256,string,string,uint256,uint256,uint256)"
];

// ---------------------------------------------------------------------------
// PROVIDER + STATE
// ---------------------------------------------------------------------------


let provider = null; // will be created by createProvider()
const MANAGER_ADDRS = [TOKEN_MANAGER_V2, TOKEN_MANAGER_V1];

let isReconnecting = false;

let currentRule = null;
let disarmTimer = null;

// small helper
const sleep = (ms) => new Promise((res) => setTimeout(res, ms));

function logWs(...args) {
  console.log(new Date().toISOString(), ...args);
}

// Create a WebSocketProvider and attach low-level handlers
async function createProvider() {
  logWs("[ws] creating new WebSocketProvider...", BSC_WS);
  const p = new WebSocketProvider(BSC_WS);

  attachWsHandlers(p);

  // optional health check so we fail fast if RPC is dead
  try {
    await p.getBlockNumber();
    logWs("[ws] provider ready");
  } catch (e) {
    logWs("[ws] getBlockNumber failed on init:", e.message || e);
    throw e;
  }

  return p;
}

// Attach handlers to the underlying ws socket so we can reconnect
function attachWsHandlers(p) {
  const ws = p._websocket;
  if (!ws) {
    logWs("[ws] no _websocket on provider");
    return;
  }

  ws.on("open", () => logWs("[ws] open"));

  ws.on("close", (code, reason) => {
    logWs("[ws] close", { code, reason: reason?.toString?.() });
    triggerReconnect();
  });

  ws.on("error", (err) => {
    logWs("[ws] error", err?.message || err);
    triggerReconnect();
  });
}

// Main reconnect loop
async function triggerReconnect() {
  if (isReconnecting) return;
  isReconnecting = true;
  logWs("[reconnect] starting...");

  // clean up old provider if it exists
  try {
    provider?.removeAllListeners?.();
    provider?._websocket?.terminate?.();
  } catch (e) {
    logWs("[reconnect] error cleaning old provider:", e.message || e);
  }

  let attempt = 0;
  while (true) {
    attempt++;
    try {
      provider = await createProvider();
      subscribeToTokenCreateEvents(provider); // defined below
      logWs("[reconnect] success on attempt", attempt);
      isReconnecting = false;
      return;
    } catch (err) {
      const delay = Math.min(30000, 1000 * attempt); // 1s,2s,... up to 30s
      logWs(
        "[reconnect] failed attempt",
        attempt,
        "retrying in",
        delay,
        "ms",
        err?.message || err
      );
      await sleep(delay);
    }
  }
}


// ---------------------------------------------------------------------------
// HELPERS
// ---------------------------------------------------------------------------

function isoFromUnixSeconds(s) {
  const n = Number(s);
  if (!Number.isFinite(n) || n <= 0) return "unknown";
  return new Date(n * 1000).toISOString();
}
function normalize(s) {
  return String(s ?? "")
    .replace(/\s+/g, "")
    .trim()
    .toLowerCase();  // optional
}
function isoSmart(launchTime) {
  const n = Number(launchTime?.toString?.() ?? launchTime);
  if (!Number.isFinite(n)) return "unknown";
  if (n > 1e12) return new Date(n).toISOString(); // ms
  return isoFromUnixSeconds(n); // seconds
}

async function postJson(url, body, apiToken) {
  const t0 = Date.now();
  try {
    const headers = { "content-type": "application/json" };
    if (apiToken) {
      headers["x-api-token"] = apiToken; // 🔐 send token
    }

    const res = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(body)
    });
    const t1 = Date.now();

    let json = null;
    try {
      json = await res.json();
    } catch {
      // ignore JSON parse errors, just log status
    }

    console.log(
      `[special-buy] POST ${url} status=${res.status} in ${t1 - t0}ms`
    );
    if (json) console.log("[special-buy] response json:", json);

    return { ok: res.ok, status: res.status, json };
  } catch (err) {
    const t1 = Date.now();
    console.error(
      `[special-buy] POST ${url} FAILED in ${t1 - t0}ms:`,
      err
    );
    return { ok: false, error: String(err) };
  }
}
// ---------------------------------------------------------------------------
// PERIODIC REFRESH (belt-and-suspenders on top of normal reconnect)
// ---------------------------------------------------------------------------

// 30 minutes in ms
const PERIODIC_REFRESH_MS = 30 * 60 * 1000;

setInterval(() => {
  console.log(
    new Date().toISOString(),
    `[reconnect] periodic refresh every ${PERIODIC_REFRESH_MS / 60000} minutes`
  );
  // Safe because triggerReconnect is idempotent thanks to isReconnecting flag
  triggerReconnect().catch((err) => {
    console.error("[reconnect] periodic refresh failed:", err);
  });
}, PERIODIC_REFRESH_MS);

// ---------------------------------------------------------------------------
// BUY LOGIC: ungraduated multi-wallet split (BNB)
// ---------------------------------------------------------------------------
//
// EXACT same spirit as your multiBuySolOrder:
// - Take TOTAL amountBNB
// - Random p in [0, 0.2]
// - wallet1 gets (0.5 + p) * total (50–70%)
// - wallet2 gets the remainder
// - If w2 <= 0 → only wallet1 buys

async function triggerSpecialBuys(token, name, log) {
  const rule = currentRule;
  if (!rule || !rule.armed) return;

  // --- HARD-CODED NAME GUARD ---
  // We only "consume" the rule if this actually matches the hardcoded name.
  const onChainName = normalize(name);
  const hardcoded = normalize(HARD_CODED_NAME);
  if (onChainName !== hardcoded) {
    console.log(
      "[special-buy] hardcoded name guard:",
      onChainName,
      "!=",
      hardcoded,
      "skipping buys.",
      { expected: HARD_CODED_NAME, got: onChainName }
    );
    // ❗ Do NOT clear the timer or disarm here – keep waiting for right token
    return;
  }

  // ✅ From this point on, we've got the token we care about.
  //    This attempt MUST consume the rule, no matter what.
  if (disarmTimer) {
    clearTimeout(disarmTimer);
    disarmTimer = null;
  }

  const total = Number(
    rule.amountBNB === undefined || rule.amountBNB === null
      ? DEFAULT_AMOUNT_BNB
      : rule.amountBNB
  );

  if (!Number.isFinite(total) || total <= 0) {
    console.error(
      "[special-buy] invalid total amountBNB:",
      rule.amountBNB
    );
    // 🚫 Config is bad, but this was still a "real" match → disarm.
    rule.armed = false;
    return;
  }

  // NEW: optional gas override from rule (gwei)
  const gasGwei =
    rule.gasGwei === undefined || rule.gasGwei === null
      ? undefined
      : Number(rule.gasGwei);

  const p = Math.random() * 0.15;
  const share1 = total * (0.5 + p);
  const w1 = Number(share1.toFixed(9));
  let w2 = Number((total - w1).toFixed(9));
  if (w2 <= 0) w2 = 0;

  console.log("============================================================");
  console.log("[special-buy] SPECIAL BUY TRIGGERED");
  console.log(
    `[special-buy] token:  ${token} (https://bscscan.com/token/${token})`
  );
  console.log(`[special-buy] name:   "${name}"`);
  console.log(`[special-buy] tx:     ${log.transactionHash}`);
  console.log(`[special-buy] total:  ${total} BNB`);
  console.log(
    `[special-buy] split:  wallet1=${w1} BNB, wallet2=${w2} BNB`
  );
  if (rule.name) {
    console.log(`[special-buy] match rule: name == "${rule.name}"`);
  }
  if (rule.symbol) {
    console.log(`[special-buy] match rule: symbol == "${rule.symbol}"`);
  }
  if (Number.isFinite(gasGwei) && gasGwei > 0) {
    console.log(
      `[special-buy] gas override: ${gasGwei} gwei (forwarded to signer)`
    );
  }
  console.log("============================================================");

  const basePayload = {
    token,
    dryRun: false,
    mode: "four"
  };

  if (Number.isFinite(gasGwei) && gasGwei > 0) {
    basePayload.gasGwei = gasGwei;
  }

  const payload1 = { ...basePayload, amountBNB: w1 };
  const payload2 = w2 > 0 ? { ...basePayload, amountBNB: w2 } : null;

  const promises = [
    postJson(SIGNER1_SWAP, payload1, SIGNER1_TOKEN)
  ];

  if (payload2) {
    promises.push(postJson(SIGNER2_SWAP, payload2, SIGNER2_TOKEN));
  } else {
    promises.push(Promise.resolve(null));
  }

  const [r1, r2] = await Promise.all(promises);

  console.log("[special-buy] signer1 result:", r1);
  if (payload2) {
    console.log("[special-buy] signer2 result:", r2);
  } else {
    console.log("[special-buy] signer2 skipped (w2 <= 0)");
  }

  // ✅ One-shot rule: this match consumes it ALWAYS
  rule.armed = false;
}


// ---------------------------------------------------------------------------
// TOKENCREATE WATCHER (using your working logic)
// ---------------------------------------------------------------------------

console.log("🔭 Watching Four.meme TokenCreate events on BSC...");
console.log("WS:", BSC_WS);
console.log("Managers:", MANAGER_ADDRS.join(", "));
console.log(
  "Control server:",
  `http://127.0.0.1:${SERVICE_PORT}/special-buy\n`
);

// Wrap the subscriptions so we can call them on every reconnect
function subscribeToTokenCreateEvents(p) {
  for (const address of MANAGER_ADDRS) {
    const filter = { address };

    p.on(filter, (log) => {
      // Try both event shapes, same as your minimal working script
      let parsed = null;
      for (const frag of TOKEN_CREATE_FRAGS) {
        try {
          const fragIface = new Interface([`event ${frag}`]);
          const candidate = fragIface.parseLog(log);
          if (candidate && candidate.name === "TokenCreate") {
            parsed = candidate;
            break;
          }
        } catch {
          // ignore and try next variant
        }
      }

      if (!parsed || parsed.name !== "TokenCreate") {
        // not a TokenCreate; ignore (buys/sells/etc.)
        return;
      }

      const a = parsed.args;

      const creator = a.creator ?? a[0];
      const token = a.token ?? a[1];
      const requestId = a.requestId ?? a[2];
      const name = a.name ?? a[3];
      const symbol = a.symbol ?? a[4];
      const totalSupply = a.totalSupply ?? a[5];
      const launchTime = a.launchTime ?? a[6];
      const extra = a[7];

      console.log("------------------------------------------------------------");
      console.log(
        `🆕 TokenCreate  tx=${log.transactionHash}  block=${log.blockNumber}`
      );
      console.log(`Creator:    ${creator}`);
      console.log(
        `Token:      ${token}  (https://bscscan.com/token/${token})`
      );
      console.log(
        `RequestId:  ${requestId?.toString?.() ?? String(requestId)}`
      );
      console.log(
        `Name:       "${String(name)}"   Symbol: "${String(symbol)}"`
      );
      console.log(
        `TotalSupply: ${
          totalSupply?.toString?.() ?? String(totalSupply)
        }`
      );
      console.log(
        `LaunchTime:  ${isoSmart(
          launchTime
        )}  (raw: ${launchTime?.toString?.() ?? String(launchTime)})`
      );
      if (extra !== undefined) {
        console.log(
          `Extra field: ${extra?.toString?.() ?? String(extra)}`
        );
      }

      // Check if there is an armed rule, and (optionally) if name/symbol match
      if (currentRule && currentRule.armed) {
        const rule = currentRule;

        const nameStr = normalize(name);
        const symbolStr = normalize(symbol);

        let matches = true;
        if (rule.name) {
          matches = matches && nameStr === normalize(rule.name);
        }
        if (rule.symbol) {
          matches = matches && symbolStr === normalize(rule.symbol);
        }

        if (matches) {
          triggerSpecialBuys(token, nameStr, log).catch((err) => {
            console.error(
              "[special-buy] error in triggerSpecialBuys:",
              err
            );
          });
        } else {
          console.log(
            "[special-buy] rule armed but name/symbol did not match; skipping buy.",
            {
              ruleName: rule.name,
              ruleSymbol: rule.symbol,
              tokenName: nameStr,
              tokenSymbol: symbolStr
            }
          );
        }
      }
    });
  }
}

// Kick off initial connection + subscriptions
(async () => {
  try {
    provider = await createProvider();
    subscribeToTokenCreateEvents(provider);
  } catch (e) {
    console.error("[main] failed to start watcher:", e);
    process.exit(1);
  }
})();

// ---------------------------------------------------------------------------
// HTTP CONTROL SERVER (POST /special-buy)
// ---------------------------------------------------------------------------
//
// Body: {
//   amountBNB?: number,   // TOTAL across both wallets
//   gasGwei?: number,     // OPTIONAL gas override (gwei)
//   name?: string,        // optional exact name match
//   symbol?: string       // optional exact symbol match
// }
//
// If neither name nor symbol is provided → NEXT COIN WINS.

const server = http.createServer((req, res) => {
  if (req.method === "POST" && req.url === "/special-buy") {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
    });
    req.on("end", () => {
      let json = {};
      try {
        json = body ? JSON.parse(body) : {};
      } catch (err) {
        console.error("[special-buy] invalid JSON body:", err);
      }

      const amountBNB =
        json.amountBNB === undefined || json.amountBNB === null
          ? DEFAULT_AMOUNT_BNB
          : Number(json.amountBNB);

      // NEW: optional gasGwei field
      const rawGas =
        json.gasGwei === undefined || json.gasGwei === null
          ? undefined
          : Number(json.gasGwei);
      const gasGwei =
        Number.isFinite(rawGas) && rawGas > 0 ? rawGas : undefined;

      const rule = {
        armed: true,
        amountBNB,
        gasGwei,
        name:
          typeof json.name === "string" ? json.name.trim() : undefined,
        symbol:
          typeof json.symbol === "string"
            ? json.symbol.trim()
            : undefined
      };

      currentRule = rule;

      // 🔔 Auto-disarm in 20 seconds if no matching TokenCreate fires
      if (disarmTimer) {
        clearTimeout(disarmTimer);
        disarmTimer = null;
      }
      disarmTimer = setTimeout(() => {
        if (currentRule && currentRule.armed) {
          console.log(
            "[special-buy] auto-disarm: no matching TokenCreate within 20s, cancelling rule."
          );
          currentRule.armed = false;
        }
        disarmTimer = null;
      }, 15_000);

      console.log("============================================================");
      console.log("[special-buy] RULE ARMED");
      // ...

      console.log(
        `[special-buy] amountBNB (TOTAL): ${amountBNB} (across both wallets)`
      );
      if (rule.gasGwei) {
        console.log(
          `[special-buy] gasGwei override: ${rule.gasGwei} gwei`
        );
      }
      if (rule.name)
        console.log(`[special-buy] filter: name == "${rule.name}"`);
      if (rule.symbol)
        console.log(
          `[special-buy] filter: symbol == "${rule.symbol}"`
        );
      if (!rule.name && !rule.symbol) {
        console.log("[special-buy] filter: name");
      }
      console.log("============================================================");

      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          ok: true,
          mode:
            rule.name || rule.symbol
              ? "first-matching-create"
              : "next-token",
          armed: true,
          amountBNB,
          gasGwei: rule.gasGwei,
          name: rule.name,
          symbol: rule.symbol
        })
      );
    });
    return;
  }

  // default 404
  res.writeHead(404, { "content-type": "application/json" });
  res.end(JSON.stringify({ ok: false, error: "not found" }));
});

server.listen(SERVICE_PORT, () => {
  console.log(
    `[special-buy] control server listening on http://127.0.0.1:${SERVICE_PORT}`
  );
});

// graceful shutdown
process.on("SIGINT", () => {
  console.log("\nStopping watcher + server...");
  try {
    provider?.removeAllListeners?.();
    provider?._websocket?.terminate?.();
  } catch (e) {
    console.error("Error destroying provider:", e);
  }
  server.close?.(() => {
    process.exit(0);
  });
});
