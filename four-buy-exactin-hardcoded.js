// buy-meme-router-fast-fixed-2.js
// Fast hard-coded buy via router -> AMAP tokenManager (fixed ENS + checksum issues)
// WARNING: real tx — use a burner private key only.

const {
  JsonRpcProvider,
  Wallet,
  Interface,
  parseEther,
  parseUnits,
  getAddress,
} = require('ethers');

// ------------------ HARD-CODED CONFIG ------------------
const RPC_URL       = 'https://bsc-dataseed.binance.org';
const CHAIN_ID      = 56;

// REPLACE WITH A BURNER KEY (0x...)
const PRIVATE_KEY   = '';

// Router & addresses (FULL correct values — do NOT slice)
const ROUTER        = '0x1de460f363AF910f51726DEf188F9004276Bf4bc';
const TOKEN_MANAGER = '0x5c952063c7fc8610ffdb798152d69f0b9550762b';

// Token to buy
const TOKEN_TO_BUY  = '0x535779626876b2b571b1878f70a05da281e04444';

// Parameters
const VALUE_BNB     = '0.001';
const GAS_GWEI      = '3';
const GAS_LIMIT     = 350000n;
const MIN_TOKENS    = 0n; // slippage guard (0 = none)
// -------------------------------------------------------

const ROUTER_ABI = [
  'function buyMemeToken(address tokenManager,address token,address recipient,uint256 funds,uint256 minAmount) external payable'
];
const iface = new Interface(ROUTER_ABI);

(async () => {
  if (!PRIVATE_KEY || PRIVATE_KEY.length < 10) {
    console.error('ERROR: set PRIVATE_KEY to a burner key in the script and re-run.');
    process.exit(1);
  }

  // Validate addresses early (will throw if invalid)
  try {
    getAddress(ROUTER);
    getAddress(TOKEN_MANAGER);
    getAddress(TOKEN_TO_BUY);
  } catch (e) {
    console.error('Address checksum/format error:', e.message);
    process.exit(1);
  }

  // DO NOT pass a `network` object here — use plain JsonRpcProvider to avoid ENS checks
  const provider = new JsonRpcProvider(RPC_URL);

  const wallet = new Wallet(PRIVATE_KEY, provider);
  const from = wallet.address;

  const fundsWei = parseEther(VALUE_BNB);
  const gasPrice = parseUnits(String(GAS_GWEI), 'gwei');

  const data = iface.encodeFunctionData('buyMemeToken', [
    TOKEN_MANAGER,
    TOKEN_TO_BUY,
    from,
    fundsWei,
    MIN_TOKENS,
  ]);

  console.log('--- fast buy (fixed ENS + checksum) ---');
  console.log('from:      ', from);
  console.log('router:    ', ROUTER);
  console.log('mgr:       ', TOKEN_MANAGER);
  console.log('token:     ', TOKEN_TO_BUY);
  console.log('value:     ', VALUE_BNB, 'BNB');
  console.log('gasPrice:  ', GAS_GWEI, 'gwei');
  console.log('selector:  ', data.slice(0, 10));

  try {
    // fetch pending nonce (single RPC)
    const nonce = await provider.getTransactionCount(from, 'pending');

    const tx = {
      chainId: CHAIN_ID,
      to: ROUTER,
      data,
      value: fundsWei,
      gasPrice,
      gasLimit: GAS_LIMIT,
      nonce,
      type: 0,
    };

    // sign locally
    const raw = await wallet.signTransaction(tx);

    // broadcast raw tx and capture the immediate hash
    const hash = await provider.send('eth_sendRawTransaction', [raw]);
    console.log('\nTX broadcast hash:', hash);

    // wait for 1 confirmation (timeout 120s)
    const receipt = await provider.waitForTransaction(hash, 1, 120_000);
    if (!receipt) {
      console.warn('Timed out waiting for receipt. Check the tx hash on BscScan:', hash);
      return;
    }

    console.log('Mined. status:', receipt.status, 'gasUsed:', receipt.gasUsed.toString());
    if (receipt.status === 1) {
      console.log('BUY SUCCESS! txHash =', hash);
    } else {
      console.warn('TX mined but failed (status != 1). txHash =', hash);
      console.warn('Receipt:', receipt);
    }
  } catch (err) {
    // friendly error reporting
    if (err?.error && err.error?.message) {
      console.error('Send failed (inner):', err.error.message);
    } else {
      console.error('Send failed:', err?.message || err);
    }
  }
})();
