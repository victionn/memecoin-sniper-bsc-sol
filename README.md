# Memecoin Sniper (BSC & Solana)

A low-latency, event-driven trading system designed to detect early signals from social media and execute token purchases in real time across Binance Smart Chain and Solana.

---

## Overview
The system monitors tweet activity from key accounts, extracts relevant signals using keyword and image-based heuristics, and automatically executes trades within milliseconds of detection.

---

## Key Features

- **Real-time Signal Detection**
  - Monitors tweets from selected KOLs (Key Opinion Leaders)
  - Uses keyword matching and basic image heuristics to identify potential bullish signals

- **Automated Trade Execution**
  - Executes transactions on BNB and Solana
  - Supports multi-wallet and parallel execution paths

- **Low Latency Infrastructure**
  - Average execution latency: ~30ms  
  - Best observed: ~11ms  
  - Designed to achieve same-block inclusion when possible

- **Browser Extension UI**
  - Displays detected signals and trade status in real time
  - Allows quick configuration and monitoring
---


## Installation and Setup

- Go into extension on your browset and load the extension folder in. 
<img width="1504" height="788" alt="image" src="https://github.com/user-attachments/assets/cfc739a9-b532-4305-8411-ac82f92adcd5" />

- In the extension, go into settings and enter the API keys for your respective signers. Second one is optional and for bundle purchases.
<img width="638" height="869" alt="image" src="https://github.com/user-attachments/assets/62cdc429-4adf-4585-9410-2472eaa0571c" />

- Open app.uxento.io, the twitter API the system will use to extract tweets in real time. You should see new tweets come up as a toast on the bottom right, meaning they are processed by the sniper. 
<img width="2375" height="1115" alt="image" src="https://github.com/user-attachments/assets/0be71cc1-d9b9-4281-8f73-295c8d7c7b86" />
- Now open PowerShell and navigate to your signer(s) folder. Run:

```bash
npm install
npm start
```
<img width="1700" height="577" alt="image" src="https://github.com/user-attachments/assets/eb80e4fa-e4a8-449a-9306-410c7b67f4c1" />

- Now you're ready to snipe! Type in heuristics, keywords or authors that may be bullish for a memecoin. Select the chain (BNB/SOL) and save. Infinite amount of orders can be processed but the more orders there are, the slower the processing for matching.
<img width="565" height="856" alt="image" src="https://github.com/user-attachments/assets/e21b4828-a639-485a-aa64-6a1264416937" />

##Advanced Settings
- Night mode: Automatically sell your position after x seconds defined by you.
- Multi buy: Buy on multiple wallets
- Slippage: Mainly used to prevent MEVs with high gas fees, set the maximum price movement you are willing to accept before the trade executes

<img width="583" height="642" alt="image" src="https://github.com/user-attachments/assets/6ef39f28-3906-4e6b-8359-51c4f70470f2" />




- 
- 

## Architecture (High Level)

- **Signal Detection**: Parses tweets and extracts actionable triggers  
- **Trigger Engine**: Decides whether to act based on predefined rules  
- **Signer Service**: Handles transaction signing and broadcasting  
- **Execution Layer**: Sends transactions to chain RPC endpoints  

---

## Tech Stack

- **JavaScript / Node.js**
- **Browser Extension APIs**
- **Ethers.js / Solana Web3**
- **Custom Signer Service**
- **BSC & Solana RPC Infrastructure**

---

## Performance

- ~30ms average execution latency  
- ~11ms best case  
- Achieved same-block inclusion under highly competitive fills

---

## Future Improvements

- Better signal filtering (reduce false positives)
- More advanced image classification
- Improved MEV protection strategies
- Adaptive gas pricing strategies

---
