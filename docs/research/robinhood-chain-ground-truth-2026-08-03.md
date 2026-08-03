# Robinhood Chain — Technical Ground Truth (researched 2026-08-03)

Compiled for the RH-chain autonomous LP platform design (see docs/plans/08).
Every claim sourced at research time; UNVERIFIED items flagged. Two facts
verified directly on-chain (chain ID via eth_chainId; v3 fee tiers via
feeAmountTickSpacing eth_call).

## 1. Chain basics
- Arbitrum Orbit (Nitro) L2, settles to Ethereum w/ blob DA. Chain ID **4663** (0x1237). Mainnet 2026-07-01. Gas token ETH. Block time ~100ms.
- RPC: `https://rpc.mainnet.chain.robinhood.com` (rate-limited, not for prod); WS `wss://feed.mainnet.chain.robinhood.com`; sequencer `https://sequencer.mainnet.chain.robinhood.com`. Third-party: Alchemy (`robinhood-mainnet.g.alchemy.com/v2/{KEY}` + wss), QuickNode, Blockdaemon, dRPC, Chainstack, Dwellir, Goldsky. Ankr UNVERIFIED.
- Explorer: Blockscout `https://robinhoodchain.blockscout.com` (API + gas tracker).
- Gas measured 2026-08-03: 0.02 gwei → swap ≈ $0.01–0.02, LP mint ≈ $0.03–0.05 L2-side + variable L1 blob fee. Order-of-magnitude only.
  Sources: docs.robinhood.com/chain/connecting, /gas-and-fees/; chainstack.com/what-is-robinhood-chain; dwellir.com/blog/what-is-robinhood-chain

## 2. Uniswap deployment (v2, v3, v4, UniswapX all live since 2026-07-02)
v3 (developers.uniswap.org/docs/protocols/v3/deployments/v3-robinhood-chain-deployments):
- Factory `0x1f7d7550b1b028f7571e69a784071f0205fd2efa`
- NonfungiblePositionManager `0x73991a25c818bf1f1128deaab1492d45638de0d3`
- SwapRouter02 `0xcaf681a66d020601342297493863e78c959e5cb2`
- QuoterV2 `0x33e885ed0ec9bf04ecfb19341582aadcb4c8a9e7`
- TickLens `0x7dfd4f31be6814d2906bde155c3e1b146eac1468`
- UniversalRouter `0x8876789976decbfcbbbe364623c63652db8c0904`
- Permit2 `0x000000000022D473030F116dDEE9F6B43aC78BA3`
v4 (developers.uniswap.org/docs/protocols/v4/deployments):
- PoolManager `0x8366a39cc670b4001a1121b8f6a443a643e40951`
- PositionManager `0x58daec3116aae6d93017baaea7749052e8a04fa7`
- Quoter `0x8dc178efb8111bb0973dd9d722ebeff267c98f94`
- StateView `0xf3334192d15450cdd385c8b70e03f9a6bd9e673b`
- Fee tiers (v3, verified on-chain): 0.01%/1, 0.05%/10, 0.30%/60, 1.00%/200. Memecoins overwhelmingly at 1% vs WETH.
- Indexing: The Graph supports the chain; Goldsky + Ormi run Graph-compatible subgraphs; Uniswap Labs API supports 4663. Official hosted Uniswap subgraph ID: UNVERIFIED — plan to self-deploy (github.com/Uniswap/v3-new-chain-deployments) or use the Uniswap API.

## 3. Bridging & USDG
- Canonical: Arbitrum bridge (portal.arbitrum.io). In ~10min; OUT ~7 days (challenge period).
- Fast routes: Relay, Across (seconds), Stargate/LayerZero OFT, CCIP, LI.FI + 0x. From Solana: aggregators only (Relay, Jumper). Fee schedules: quote live, UNVERIFIED.
- USDG = Global Dollar (Paxos Digital Singapore, MAS-supervised, 1:1 USD). RH contract `0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168`. WETH `0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73`.

## 4. Pool discovery / data — SOLVED (the design prompt's "hardest subsystem" is easy)
- GeckoTerminal: network slug `robinhood`, free public API verified live (`/api/v2/networks/robinhood/trending_pools` returns v3+v4 pools w/ reserve+volume; new-pools + OHLCV too).
- DEX Screener: `dexscreener.com/robinhood`, same slug in API.
- DefiLlama: chain + DEX volume pages + API verified (`api.llama.fi/v2/historicalChainTvl/Robinhood`).
- Krystal: probable but UNVERIFIED official support; community uses it for position cards.
- Blockscout API; Chainstack open-source sequencer-feed decoder (github.com/chainstacklabs/robinhood-chain-sequencer-feed).

## 5. Ecosystem reality
- TVL ~$389M, +42% over last 30d (growing). Bridged ~$1.09B; stables ~$536M (USDG ~60%).
- DEX volume ~$242M/24h, ~$3.16B/7d, weekly change −20% — cooling from the mid-July frenzy peak ($877M/24h, briefly #2 globally). TVL up, volume down from peak.
- What trades: memecoins vs WETH at 1% tier — STONKBROKER, SESTRI, IF, JPORK, WOOF, GME, BRODIE (FRONG UNVERIFIED). Pool TVLs $100k–$4M = Meridian-scale, very high fee/TVL.
- VLAD incident 2026-07-23: Tenev X account hacked, fake VLAD launched via Pons launchpad; ~$1.2M attacker profit via CREATOR FEE FARMING, not a liquidity rug (Pons locks LP). Lesson: locked LP ≠ safe; fee-farming scams keep pools alive and tradeable. No chain infra affected.

## 6. MEV / execution
- Centralized sequencer, strict FCFS ordering; priority fees do NOT reorder; no Timeboost; no public mempool → **no sandwich/frontrun-by-fee**. No private lane needed.
- Real vector: LATENCY racing — sequencer in Ohio; ~2-block advantage for co-located actors; sequencer feed publicly decodable pre-execution.
- Withdrawals: standard Orbit 7-day challenge; sequencer-down fallback via delayed inbox.

## Bot-relevant synthesis
Gas ≈ cents → Solana-style gas-break-even constraints vanish (frequent rebalancing viable).
Discovery free via GeckoTerminal/DEXScreener APIs. Exits pay AMM impact but no sandwich tax.
Ecosystem is 1 month old: growing TVL, volume −20% off peak, Meridian-sized WETH-quoted 1% memecoin pools.
