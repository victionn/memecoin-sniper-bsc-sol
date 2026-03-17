# Memecoin Sniper (BSC & Solana)

A low-latency, event-driven trading system designed to detect early signals from social media and execute token purchases in real time across Binance Smart Chain and Solana.

---

## Overview

This project was built to explore how **latency, signal detection, and execution speed** affect outcomes in highly volatile markets like memecoins.

The system monitors tweet activity from key accounts, extracts relevant signals using keyword and image-based heuristics, and automatically executes trades within milliseconds of detection.

---

## Key Features

- **Real-time Signal Detection**
  - Monitors tweets from selected KOLs (Key Opinion Leaders)
  - Uses keyword matching and basic image heuristics to identify potential launches

- **Automated Trade Execution**
  - Executes transactions on **BSC and Solana**
  - Supports multi-wallet and parallel execution paths

- **Low Latency Infrastructure**
  - Average execution latency: ~30ms  
  - Best observed: ~11ms  
  - Designed to achieve same-block inclusion when possible

- **Browser Extension UI**
  - Displays detected signals and trade status in real time
  - Allows quick configuration and monitoring

---

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
- Achieved same-block inclusion under competitive gas conditions  
- 18 automated trades executed (Nov 2025 – Jan 2026)

---

## Future Improvements

- Better signal filtering (reduce false positives)
- More advanced image classification
- Improved MEV protection strategies
- Adaptive gas pricing strategies

---
