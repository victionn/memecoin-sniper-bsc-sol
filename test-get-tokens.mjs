import { JsonRpcProvider, Contract, parseEther } from 'ethers';

// ===== CONFIG =====
const RPC = 'https://bsc.rpc.blxrbdn.com';  // Your fast RPC
const PANCAKE_ROUTER = '0x10ED43C718714eb63d5aA57B78B54704E256024E';
const WBNB = '0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c';

// Token to test (use any BSC token)
const TOKEN = '0xc1737ca032b09848efcad3455519d98b96784444'; // USDT for example

// Amount to buy
const AMOUNT_BNB = 0.01;

// ===== ROUTER ABI (minimal - just getAmountsOut) =====
const ROUTER_ABI = [
  'function getAmountsOut(uint amountIn, address[] memory path) public view returns (uint[] memory amounts)'
];

async function testGetExpectedTokens() {
  console.log('🧪 Testing getAmountsOut latency...\n');
  
  const provider = new JsonRpcProvider(RPC);
  const router = new Contract(PANCAKE_ROUTER, ROUTER_ABI, provider);
  
  const amountIn = parseEther(String(AMOUNT_BNB));
  const path = [WBNB, TOKEN];
  
  // Run 5 tests to get average
  const times = [];
  
  for (let i = 0; i < 5; i++) {
    const start = performance.now();
    
    try {
      const amounts = await router.getAmountsOut(amountIn, path);
      const expectedTokens = amounts[1]; // Output amount
      
      const elapsed = performance.now() - start;
      times.push(elapsed);
      
      console.log(`Test ${i + 1}: ${elapsed.toFixed(2)}ms - Expected: ${expectedTokens.toString()}`);
      
      // Calculate minAmountOut with 10% slippage
      const slippage = 10;
      const slippageMultiplier = 10000n - BigInt(slippage * 100);
      const minAmountOut = (expectedTokens * slippageMultiplier) / 10000n;
      
      console.log(`  → With ${slippage}% slippage: minOut = ${minAmountOut.toString()}\n`);
      
    } catch (err) {
      console.error(`Test ${i + 1} failed:`, err.message);
    }
    
    // Small delay between tests
    await new Promise(r => setTimeout(r, 100));
  }
  
  if (times.length > 0) {
    const avg = times.reduce((a, b) => a + b, 0) / times.length;
    const min = Math.min(...times);
    const max = Math.max(...times);
    
    console.log('═══════════════════════════════════════');
    console.log(`📊 Results (${times.length} tests):`);
    console.log(`   Average: ${avg.toFixed(2)}ms`);
    console.log(`   Min: ${min.toFixed(2)}ms`);
    console.log(`   Max: ${max.toFixed(2)}ms`);
    console.log('═══════════════════════════════════════');
    
    if (avg < 50) {
      console.log('✅ FAST - Good for sniping!');
    } else if (avg < 100) {
      console.log('⚠️  MEDIUM - Acceptable but adds latency');
    } else {
      console.log('❌ SLOW - Not recommended for competitive sniping');
    }
  }
}

testGetExpectedTokens().catch(console.error);
