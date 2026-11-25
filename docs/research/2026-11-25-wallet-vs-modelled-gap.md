# Wallet result vs modelled result on bot closes — what the model leaves out

2026-11-25 · read-only study · snapshot of kv `lessons` → performance taken ~18:50 WIB (1,471 records) · chain re-read of 38 bot closes + 2 operator closes on the VM (read-only scripts piped over stdin; nothing written there).

## Summary

- **Reproduced:** over the 30 days to the snapshot, 85 bot closes (not adopted, not a rebalance leg) carry `pnl_sol_net_source = "wallet"` and a `pnl_sol_net_modelled`. Σ (wallet − modelled) = **−◎0.1322** (mean −◎0.00156, median −◎0.00021). The dashboard's −◎0.1331 adds the one `wallet_group` close (PUSSY 268X9or3, −◎0.00096).
- **Where it comes from (◎, Σ over the 85):** two-sided entry premium **−0.0674** (51 %) · Jupiter route token-account rent the audit charges and never credits back **−0.0440** (33 %) · Jupiter's 10 bps fee missing from the recorded swap output **−0.0143** (11 %) · exit-swap gas **−0.0015** · other tx fees **−0.0009** · valuation timing on two-sided positions **−0.0038** · fee-token valuation **−0.0016** · pre-held tokens sold in the window **+0.0029** · unattributed **−0.0016**.
- **Real costs the model omits: ≈ −◎0.084** (entry premium, Jupiter fee, swap gas, other fees). The bot already measures the biggest one (`entry_cost_sol`) and does not subtract it.
- **Audit artefact: ≈ −◎0.044.** The wallet figures written into the records are about ◎0.044 too LOW. Rent for intermediate-token accounts that a Jupiter route opens is counted against the position. The sweeper returns that rent later, in a transaction no record counts. All 29 such accounts in the sample were closed later, with the rent paid back.
- **Timing / attribution, sign varies: ≈ −◎0.003 net.** No action.
- The 15 straddled closes produce 55 % of the gap. Their gross result is +◎0.117, modelled +◎0.081 and wallet +◎0.008. Net of its buy premium, the straddle lane has been about break-even for 30 days.
- The per-close identity closes **exactly**. On every one of the 38 re-read closes, the chain-derived wallet net reproduces the stored `pnl_sol_net` to within ◎5e-7. The components then add up to the gap with a residual of 0.

## 1. Reproduction

| | n | Σ wallet − modelled |
|---|---:|---:|
| bot, `pnl_sol_net_source = wallet`, has `pnl_sol_net_modelled` (30 d to 2026-11-25 11:50Z) | 85 | −◎0.13216 |
| + `wallet_group` (PUSSY 268X9or3, group-allocated residual) | 1 | −◎0.00096 |
| dashboard `costSplit().adjustment_sol` (also absorbs modelled rows' swap gas, +◎0.000008) | 88 rows / 86 audited | −◎0.13312 |

- `pnl_sol_net_modelled` = `pnl_sol − total_gas_sol − exit_slippage_sol` on all 85 (max |deviation| ◎1e-6). The exit swap's own gas is NOT in it. 29, 30 and 31-day windows give the same 85.
- All 85 are audit v9, status `ok`, applied. None is a backfill.
- **Distribution of the per-close gap:** p5 −0.0077, p10 −0.0037, p25 −0.0017, median −0.00021, p75 −0.00002, p90/p95 0.0000. 53 of 85 (62 %) have |gap| < ◎0.0005; 70 are negative and 4 positive. The 10 most negative carry −◎0.0873 (66 %). The 5 most positive carry +◎0.0058.

| stratum | n | Σ gap | median |
|---|---:|---:|---:|
| straddled (`straddle_count > 0`) | 15 | −0.0732 | −0.0037 |
| not straddled | 70 | −0.0589 | −0.00017 |
| `entry_cost_source` straddle / measured / none | 15 / 1 / 69 | −0.0732 / −0.0157 / −0.0433 | |
| exit swap happened / none | 67 / 18 | −0.1306 / −0.0015 | −0.00032 / 0 |
| `slippage_basis` pool / none (no feed rows in the window) | 67 / 18 | as above | |
| capital ≥ ◎1.2 / 0.6–1.2 / 0.3–0.6 | 8 / 12 / 65 | −0.0582 / −0.0095 / −0.0645 | −0.0052 / −0.0002 / −0.0002 |
| family trailing_tp / stop_loss / oor_above_unfilled / other | 29 / 9 / 18 / 29 | −0.0737 / −0.0185 / −0.0042 / −0.0358 | |
| `open_account_rent_sol` set / `released_account_rent_sol` set / `dust_residual` | 11 / 7 / 7 | −0.0015 / −0.0077 / −0.0015 | |
| `pnl_source` closed_api / cache_fallback | 74 / 11 | −0.1141 / −0.0181 | |

- **Token-2022 transfer fees:** none. On every re-read close, the token amounts on chain match Meteora's deposit / withdrawal / fee amounts to the unit.
- **v8/v9 rent set-asides:** these are netted in the stored `net_sol` exactly as CLAUDE.md says. My chain recomputation applies them and reproduces the record on all 38 closes.

## 2. Method

The gap is defined as gap = wallet − modelled = W − pnl_sol + gas + slip. For each re-read close:

- **W** is rebuilt from chain with the audit's v9 rules: the position account's transactions, plus the wallet transactions that touch the wallet's token account of the mint (listed from that account's own signatures, SPL and Token-2022). Account-only transactions are counted as −Δ(mint account) and the open / released rent set-asides are applied.
- **Each counted transaction** is split into:
  - its fee;
  - the rent of accounts it creates or closes;
  - its "core" SOL: the SOL that moves to or from the position, or through a swap.
- **The record's `pnl_sol`** is taken apart with Meteora's closed-position record: per-leg token amounts and SOL valuations (`allTimeDeposits / Withdrawals / Fees` tokenX / tokenY `amount` + `amountSol`).

This gives

gap = (Meteora settled − record pnl) + (Y on chain − Y Meteora) − (fees − `total_gas_sol`) − (rent created − rent returned) + [sells − buys + slip − (X withdrawn + X fees − X deposited, at Meteora's valuation)]

The bracket is then split:
- **two-sided positions:** into the entry premium (`entry_cost_sol`) and the Jupiter exit fee, with the rest as valuation;
- **SOL ladders:** into the Jupiter exit fee, exit price drift (the bot's bin-price reference against Meteora's withdrawal valuation), fee-token valuation, and tokens the wallet held before the position.

**Sample: 38 closes.** It includes every close with |gap| ≥ ◎0.0005 (32 closes, −◎0.1206) plus 6 spread over the small ones (−◎0.0059). Together they cover −◎0.1265 of −◎0.1322. The remaining 47 closes carry −◎0.0057. Scripts and raw output are in the session scratchpad `walletgap/` (`fetch.mjs`, `rentfu.mjs`, `attrib3.py`, `flows.json`, `rentfu.json`).

## 3. Decomposition of the −◎0.132

| # | component | Σ ◎ | share | n affected | per-close median | kind | confidence |
|---|---|---:|---:|---:|---:|---|---|
| 1 | **Two-sided entry premium.** Straddle stage-B buy, or a UI re-range zap, paid above Meteora's deposit valuation (impact + route fee + bins moved). | −0.0674 | 51 % | 16 (15 straddles + JIMMY EvJVmJjC, a bot position the operator re-ranged in the UI) | −0.0033 | real cost, not in the model | measured on all: the record field `entry_cost_sol` (Σ −0.06752) equals the chain identity on 16 / 16 |
| 2 | **Route-token account rent.** The exit swap (or a straddle buy) routes through USDC / USDT / cbBTC / JUP / NVDAx / … and opens a wallet token account for the intermediate mint (◎0.00149–0.00156). The audit counts that rent against the position; it comes back later, when the account is closed, in a transaction no record counts. | −0.0440 | 33 % | 18 closes, 29 accounts | −0.0023 | **audit artefact** (actual cost ≈ ◎0.000005 per close) | measured on the sample. The other 47 closes have \|gap\| < ◎0.0005, so none of them can carry an un-offset ◎0.0015 account. All 29 accounts are closed today with the rent back in the wallet (§5). |
| 3 | **Jupiter's 10 bps fee on the exit swap.** The recorded `exit_swap.sol_received` is 0.100 % above what landed in the wallet, so `exit_slippage_sol` understates the swap cost by that amount. | −0.0143 | 11 % | 67 (every exit swap) | −0.00022 | real cost, mis-measured | measured on 37 / 37 sampled swaps (−0.0105; all 0.100 % ± 0.002 pp, larger only on swaps under ◎0.004). The other 30 use the proxy 0.1 % × `sol_received` (−0.0038). |
| 4 | **Exit-swap gas** (`exit_swap.gas_sol` is not in `total_gas_sol`) | −0.0015 | 1.1 % | 67 | −0.000006 | real cost, not in the model | measured on all |
| 5 | **Other transaction fees** not in `total_gas_sol`: straddle stage transactions, extra close / claim transactions, mid-life swaps | −0.0009 | 0.7 % | ~20 | −0.00001 | real cost, not in the model | sample only (unsampled ones are inside row 9) |
| 6 | **Valuation timing on two-sided positions.** Meteora values each deposit / withdrawal at its event price; the record took the cache (cache-fallback closes) and the headroom tokens are sold at exit. | −0.0038 | 2.8 % | 15 | −0.0001 (range −0.0041 … +0.0030) | timing / attribution | sample (all 15 straddles are in it) |
| 7 | **Fee-token valuation.** Meteora values fee tokens when they are earned; they are sold at the exit price. | −0.0016 | 1.2 % | 18 SOL-ladder exit swaps | −0.00001 (one case −0.0016) | timing | sample |
| 8 | **Pre-held tokens sold inside the window.** Leftovers of an earlier position, sold by the dust sweeper while this one lived (`residual_tokens` < 0 on the record). | +0.0029 | −2.2 % | 5 | +0.0003 | audit attribution artefact | sample |
| 9 | Unsampled residual (47 closes, after rows 3–4 proxies) | −0.0016 | 1.2 % | 47 | ≈ 0 | unattributed | — |
| 10 | Exit price drift: bot's bin-price reference vs Meteora's withdrawal valuation | 0.0000 | 0 | 18 | 0.000 % | — | sample: the two agree to rounding once the Jupiter fee is separated |
| 11 | Y-leg mismatch, position / bin-array rent, failed-transaction fees, Token-2022 transfer fees | ≈ 0.0000 | 0 | — | — | — | sample: position-account rent always comes back; no bin array was created at our cost; 2 failed transactions (◎0.00003); no transfer-fee mint |
| | **Total** | **−0.1322** | 100 % | 85 | | | |

**By kind:**
- real costs the model omits: rows 1, 3, 4, 5 = **−◎0.084**;
- audit artefacts: rows 2 + 8 = **−◎0.041**, i.e. the applied wallet figures read ◎0.041 below the truth;
- timing (sign varies): rows 6 + 7 = −◎0.005;
- unattributed: −◎0.002.

## 4. Sample attribution (38 closes, sorted by gap, ◎)

- "two-sided buy" = the record has an `entry_cost_sol` (straddle, or the UI re-range of JIMMY EvJVmJjC).
- "other" = Y-leg / position-rent offsets + exit drift + residual; it is ≤ ◎0.00001 on every row.

| # | position | pair | exit | ◎ cap | two-sided buy | gap | entry premium | route-ATA rent (n) | Jupiter fee | swap gas | other fees | two-sided valuation | fee-token valuation | pre-held tokens | other |
|---|---|---|---|---:|:-:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| 1 | 3TLwMpEZ | BAGSPAY-SOL | trailing_tp | 1.51 | yes | -0.02023 | -0.01918 | 0 (0) | -0.00080 | -0.00001 | -0.00001 | -0.00022 | 0 | 0 | 0 |
| 2 | EvJVmJjC | JIMMY-SOL | trailing_tp | 2.10 | yes | -0.01567 | -0.01466 | 0 (0) | -0.00098 | -0.00001 | -0.00001 | 0 | 0 | 0 | -0.00001 |
| 3 | BQHq8TyA | Diamond-SOL | trailing_tp | 1.79 | yes | -0.01100 | -0.01011 | 0 (0) | -0.00094 | -0.00001 | -0.00002 | +0.00007 | 0 | 0 | 0 |
| 4 | 4tgqnWH5 | PUSSY-SOL | oor_below | 1.28 | yes | -0.00957 | -0.00532 | -0.00617 (4) | -0.00096 | -0.00001 | -0.00015 | +0.00304 | 0 | 0 | 0 |
| 5 | 6ch1DBUW | HIGH-SOL | stop_loss | 0.45 | yes | -0.00768 | -0.00321 | 0 (0) | -0.00035 | -0.00001 | -0.00001 | -0.00411 | 0 | 0 | 0 |
| 6 | 2S51ojYZ | Anakin-SOL | take_profit | 0.45 | yes | -0.00629 | -0.00449 | -0.00154 (1) | 0 | -0.00001 | -0.00008 | -0.00017 | 0 | 0 | 0 |
| 7 | 6Jv5r3qt | Anakin-SOL | trailing_tp | 0.45 | yes | -0.00570 | -0.00423 | -0.00154 (1) | -0.00018 | -0.00001 | -0.00001 | +0.00026 | 0 | 0 | 0 |
| 8 | HLYMEaM6 | CHOO-SOL | take_profit | 0.45 | yes | -0.00378 | -0.00399 | 0 (0) | -0.00016 | -0.00001 | -0.00001 | +0.00038 | 0 | 0 | 0 |
| 9 | EoK1YAaM | VEIL-SOL | manual | 0.45 | yes | -0.00373 | -0.00309 | 0 (0) | -0.00011 | -0.00001 | -0.00002 | -0.00050 | 0 | 0 | 0 |
| 10 | zZkhMPmF | PUSSY-SOL | trailing_tp | 0.45 |  | -0.00362 | 0 | -0.00305 (2) | -0.00013 | -0.00044 | 0 | 0 | 0 | 0 | 0 |
| 11 | 8sLU39cp | CHOO-SOL | stop_loss | 0.45 |  | -0.00333 | 0 | -0.00298 (2) | -0.00034 | -0.00001 | 0 | 0 | 0 | 0 | 0 |
| 12 | DA7GcVVh | PUSSY-SOL | trailing_tp | 0.85 |  | -0.00332 | 0 | -0.00305 (2) | -0.00026 | -0.00001 | 0 | 0 | 0 | 0 | 0 |
| 13 | 8pqHTEnh | Anakin-SOL | trailing_tp | 0.45 |  | -0.00331 | 0 | -0.00303 (2) | -0.00021 | -0.00007 | 0 | 0 | 0 | 0 | 0 |
| 14 | FscXUfuT | CHOO-SOL | stop_loss | 0.45 |  | -0.00331 | 0 | -0.00298 (2) | -0.00033 | -0.00001 | 0 | 0 | 0 | +0.00001 | 0 |
| 15 | FdyvhK3w | CHOO-SOL | stop_loss | 0.45 |  | -0.00329 | 0 | -0.00298 (2) | -0.00031 | -0.00001 | 0 | 0 | 0 | 0 | 0 |
| 16 | 9Kc36i2m | GTA6-SOL | rug | 0.45 |  | -0.00324 | 0 | -0.00298 (2) | -0.00025 | -0.00001 | 0 | 0 | 0 | 0 | 0 |
| 17 | 6iTbZwgs | FLOAT-SOL | trailing_tp | 0.74 | yes | -0.00323 | -0.00308 | 0 (0) | -0.00032 | -0.00001 | -0.00001 | +0.00019 | 0 | 0 | 0 |
| 18 | EDDUmBij | mihao-SOL | manual | 0.45 | yes | -0.00317 | -0.00330 | 0 (0) | -0.00017 | -0.00001 | -0.00001 | +0.00032 | 0 | 0 | 0 |
| 19 | Uwopk3YJ | Anakin-SOL | oor_above_unfilled | 0.46 |  | -0.00298 | 0 | -0.00303 (2) | 0 | -0.00001 | -0.00022 | 0 | 0 | +0.00028 | 0 |
| 20 | 5RnL9Msh | GTA6-SOL | trailing_tp | 0.45 | yes | -0.00292 | -0.00238 | 0 (0) | -0.00027 | -0.00020 | -0.00001 | -0.00005 | 0 | 0 | 0 |
| 21 | Bi9AfppS | PUSSY-SOL | trailing_tp | 0.63 |  | -0.00178 | 0 | -0.00156 (1) | -0.00022 | -0.00001 | 0 | 0 | 0 | 0 | 0 |
| 22 | 6bpYS5AG | PUSSY-SOL | trailing_tp | 0.45 |  | -0.00172 | 0 | -0.00156 (1) | -0.00015 | -0.00001 | 0 | 0 | 0 | 0 | 0 |
| 23 | 7wsdTXnx | CHOO-SOL | trailing_tp | 0.45 |  | -0.00162 | 0 | -0.00149 (1) | -0.00013 | -0.00001 | 0 | 0 | 0 | 0 | 0 |
| 24 | BVgQ6384 | CHOO-SOL | manual | 0.45 |  | -0.00162 | 0 | -0.00149 (1) | -0.00011 | -0.00001 | -0.00001 | 0 | 0 | 0 | 0 |
| 25 | C8LkAXnu | DacityCoin-SOL | rug | 0.45 |  | -0.00159 | 0 | -0.00156 (1) | -0.00023 | -0.00004 | 0 | 0 | 0 | +0.00023 | 0 |
| 26 | 24TV4mN7 | DacityCoin-SOL | harvest | 0.45 |  | -0.00157 | 0 | -0.00156 (1) | 0 | -0.00001 | 0 | 0 | 0 | 0 | 0 |
| 27 | A3i9sTZD | FLOAT-SOL | trailing_tp | 1.73 |  | -0.00083 | 0 | 0 (0) | -0.00048 | -0.00014 | -0.00027 | 0 | -0.00155 | +0.00160 | 0 |
| 28 | GzmmLVT9 | LAUNCH-SOL | stop_loss | 0.76 |  | -0.00067 | 0 | 0 (0) | -0.00057 | -0.00010 | 0 | 0 | 0 | 0 | 0 |
| 29 | E8LmbJ6g | CHOO-SOL | trailing_tp | 0.45 | yes | -0.00063 | +0.00126 | -0.00149 (1) | -0.00027 | -0.00001 | -0.00001 | -0.00011 | 0 | 0 | 0 |
| 30 | CRqJDyKR | FLOAT-SOL | stop_loss | 0.45 |  | -0.00036 | 0 | 0 (0) | -0.00032 | -0.00001 | 0 | 0 | 0 | -0.00004 | 0 |
| 31 | B4pQrgYQ | mihao-SOL | trailing_tp | 0.65 |  | -0.00022 | 0 | 0 (0) | -0.00020 | -0.00001 | 0 | 0 | 0 | 0 | -0.00001 |
| 32 | 5gNTtebQ | FLOAT-SOL | trailing_tp | 0.45 |  | -0.00011 | 0 | 0 (0) | -0.00011 | -0.00001 | 0 | 0 | 0 | 0 | 0 |
| 33 | 2emReyS5 | PUSSY-SOL | oor_above_unfilled | 0.85 |  | -0.00003 | 0 | 0 (0) | 0 | -0.00001 | 0 | 0 | -0.00001 | 0 | 0 |
| 34 | DFxSXLXa | CHOO-SOL | oor_above_unfilled | 0.45 |  | -0.00001 | 0 | 0 (0) | 0 | -0.00001 | 0 | 0 | 0 | 0 | 0 |
| 35 | 4bsz3TP9 | mihao-SOL | low_yield | 0.66 |  | 0 | 0 | 0 (0) | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| 36 | 6vxiN5Lr | PUSSY-SOL | trailing_tp | 0.45 |  | +0.00066 | 0 | 0 (0) | -0.00011 | -0.00001 | 0 | 0 | 0 | +0.00078 | 0 |
| 37 | GD5rGSpp | NIO-SOL | stop_loss | 0.45 | yes | +0.00079 | +0.00413 | 0 (0) | -0.00035 | -0.00001 | -0.00001 | -0.00298 | 0 | 0 | 0 |
| 38 | 8v1EsDaV | HIGH-SOL | trailing_tp | 0.45 | yes | +0.00415 | +0.00425 | 0 (0) | -0.00020 | -0.00001 | -0.00001 | +0.00012 | 0 | 0 | 0 |
| | **Σ 38** | | | | | **-0.1265** | **-0.0674** | **-0.0440** (29) | **-0.0105** | **-0.0012** | **-0.0009** | **-0.0038** | **-0.0016** | **+0.0029** | **-0.0000** |

**Notes on individual rows**
- **BAGSPAY 3TLwMpEZ** (−0.0202): the straddle's stage-B buy cost ◎0.7585 for tokens Meteora valued ◎0.0192 lower (2.5 % of the buy). This single buy is 15 % of the whole gap.
- **PUSSY 4tgqnWH5** (−0.0096): its straddle buy and three fee / unwind sells opened 4 route accounts (−◎0.0062). Its cache-free closed-API pnl sits −◎0.0252 below Meteora's settled figure, offset by the valuation of its sells (net +◎0.0030).
- **The CHOO / PUSSY / Anakin / GTA6 SOL-ladder stop and trailing closes at −◎0.0030…−0.0033** are almost entirely 2 route accounts each (◎0.0030) + the Jupiter fee.
- **The two positive straddles** (HIGH 8v1EsDaV +0.0042, NIO GD5rGSpp +0.0008) bought BELOW Meteora's deposit valuation (`entry_cost_sol` −◎0.0043 / −◎0.0041; the signed premium is real in both directions).
- **Uwopk3YJ / C8LkAXnu / 6vxiN5Lr:** the wallet sold 8–28 tokens left by an earlier position in the same mint during this one's window (row 8). Uwopk3YJ's mid-life "sell" of 8.36 tokens paid ◎0.0015 of route rent + ◎0.00022 fee to receive ◎0.00006.

## 5. What each component is

### Real modelling omissions

1. **Entry premium (−◎0.067).**
   - What it is: a straddle's stage-B buy (or a UI zap) pays Jupiter impact and the route fee, and the price moves between the quote and the deposit. Meteora books the deposited base at the landing price.
   - Size: median 1.37 % of the SOL spent on the buy, 0.69 % of the position's capital; range −1.9 % (bought below) … +2.5 %.
   - The bot already measures it per purchase (`entry_cost_sol`, `net-cost.js`, "measured" / "straddle" sources) but uses it only for display: `pnl_sol_net` / `pnl_sol_net_modelled` never subtract it.
   - Consequence for the straddle lane: on the 15 straddled closes of the window, gross +◎0.1165, modelled +◎0.0807, wallet +◎0.0075. Without the premium the lane looks ten times better than it has been.
2. **Jupiter fee (−◎0.014).**
   - `swapToken` (tools/wallet.js) returns `amount_out: result.outputAmountResult` from Jupiter's `/execute`. On every sampled exit swap the wallet received exactly 0.100 % less than that (e.g. 8sLU39cp recorded ◎0.344001, landed ◎0.343657). Jupiter's own per-pair fee is taken after the reported output.
   - `exitSwapSlippageSol` therefore uses a received figure that is 10 bps high, and `exit_slippage_sol` is understated by 0.1 % of the swap.
   - Same source, unverified: the Telegram swap line, and possibly the read-only quotes behind the exit-swap guard, the close-efficiency shadow and the net-cost exit estimate, if `order.outAmount` is also pre-fee.
3. **Exit-swap gas (−◎0.0015)** and **other transaction fees (−◎0.0009).**
   - `recordExitSwapOutcome` stores `exit_swap.gas_sol` but computes `pnl_sol_net = pnl_sol − total_gas_sol − slippage`.
   - Straddle stage transactions, extra claim / close attempts and mid-life swaps pay fees that are not in `total_gas_sol`. They are small, but they are always negative.

### Audit artefacts (the wallet figure is the one that is off)

4. **Route-token account rent (−◎0.044).**
   - What happens: Jupiter routes most exit swaps of these pump-style tokens through an intermediate mint and creates a wallet token account for it in the swap transaction. In the sample: 3NZ9JM…, cbBTC, USDC, USDT, JUP, NVDAx, TTWof…, pump CmXq…, 0–2 per swap; Rent is ◎0.00149–0.00156 per account. The account is left empty and open.
   - Why the audit misses the refund: the swap transaction touches the position's mint, so the audit counts its whole SOL change, rent included. The refund arrives when the account is closed, and that close does not touch the position's mint, so no audit ever reads it.
   - Fate of all 29 accounts (`rentfu.mjs`): all are closed now.
     - 19 were closed by the wallet in a one-account transaction (the bot's sweeper), rent back minus 5,000 lamports, 59 s to 3.9 days after creation.
     - 10 (the reused 3NZ9JM… and USDC accounts) were last closed in batch CloseAccount transactions whose fee payer is a third-party key (prefix `gasRUw…`; not identified — not the bot, which always pays its own fees). It closed 2–5 accounts at a time and kept ≈ 2 % of the rent. Because these accounts are reused, the last close seen can be days after this position's swap.
   - Economic cost of the 29: ≈ ◎0.0003. What the audit charged: ◎0.044.
   - It is the v8/v9 rent problem again, for accounts of OTHER mints.
   - Side effect: ledger-truth sees the refunds as unattributed wallet growth.
5. **Pre-held tokens (+◎0.003).** When the wallet already holds a leftover of the mint from an earlier position (`residual_tokens` < 0 on the audit), its sale inside this window is credited to this position.

### Timing / attribution (no fix needed)

6. **Two-sided valuation (−◎0.004) and fee-token valuation (−◎0.002).**
   - Meteora values each deposit, withdrawal and fee at the price when it happened; the wallet realises the inventory at the exit swap.
   - The sign follows the price path. In the sample it ranges −◎0.004 … +◎0.003 per close.
   - Exit price drift is zero: the bot's reference (`exitRefPriceSolPerBase`, the active-bin price read right after the close) equals Meteora's withdrawal valuation to rounding.

## 6. The reverse population and the non-applied closes

**Operator closes, same window:**
- 23 adopted closes, all wallet-audited. Σ gap only **−◎0.0031** (median −◎0.00009), but it is the net of offsetting pieces:
  - UI-zap entry premium −◎0.0164 (`entry_cost_sol` on 9);
  - Jupiter-fee proxy −◎0.0039;
  - +◎0.0173 elsewhere, almost all one close: JIMMY CYCbgJBm, +◎0.0171.
- Read on chain:
  - **Huss E96pMB2p (−◎0.0223):** the zap premium (◎0.0180 on a ◎0.896 buy, 2.0 %) + exit Jupiter fee ◎0.0014 + route rent ◎0.0027, minus 3 mid-life fee swaps that sold claimed tokens slightly above Meteora's fee valuation.
  - **JIMMY CYCbgJBm (+◎0.0171):** eight mid-life fee swaps sold 15,716 tokens for ◎0.368 where Meteora valued the fee tokens at ◎0.321 (the token rose while held). Two zap buys landed below the bin price (`entry_cost_sol` −◎0.0073).
- So yes, the UI-zap entry premium CLAUDE.md describes is there and is the same mechanism as row 1. On operator positions, mid-life fee-claim auto-swaps add a fee-inventory term of either sign that bot SOL ladders (claim-in-close) barely have.

**The non-applied bot closes:**
- **INVERSE WRqXhweK** (modelled, audit `incomplete` — "token flows do not net to zero"): 55.24 tokens left unsold with no swap in the window to price them. The difference (◎0.00077) is above the dust floor (◎0.0005), so the v8 dust rule does not apply. Correctly not applied. Its modelled net (◎0.00112) is probably ◎0.0008 high (the unsold tokens).
- **JIMMY 98gVjYNg** (closed today 08:52Z; modelled, `incomplete` — "another position in this token overlapped"): its group with the operator's JIMMY 5K2SSUFf is `group_pending` because a third JIMMY position (EsbF2V1E…) is still open. It will be allocated when that closes. Its individual figures (booked ◎0.0318, wallet ◎0.0457) cannot be split yet.
- **PUSSY 268X9or3** is the `wallet_group` close: `incomplete` alone (27.74 pre-held tokens), settled by the group audit (−◎0.00096 allocated).

## 7. Recommendations, ranked by SOL at stake

1. **(i) Record / model fix — subtract the measured entry premium. ◎0.067 / 30 d.**
   - In `recordExitSwapOutcome` (lessons.js; and wherever `pnl_sol_net` is first composed at close), use `pnl_sol − gas − slippage − entry_cost_sol` whenever `entry_cost_source` is `measured` or `straddle`, and the same in the external-reconcile record.
   - Keep `entry_cost_sol` signed (a below-bin buy is a gain).
   - Before relying on it, check two things: that `entry_cost_sol` sums every purchase of a position (multi-straddle / multi-zap — CYCbgJBm had two zap buys), and that it still matches the audit on the next 20 two-sided closes.
2. **(i) Audit fix — set aside route-account rent. ◎0.044 / 30 d of wallet figures too low.**
   - In `summarizeFlows` (close-audit.js), for each counted transaction add up the lamports put into wallet-owned token accounts of mints OTHER than the base mint and wSOL that the transaction creates (pre-balance 0). Store this as `route_account_rent_sol` and add it back in `evaluateCloseAudit`, as v8 does for `open_account_rent_sol`. The refund is never counted, so there is nothing to mirror.
   - `walletDeltas` already reads the token balances; it needs the owner / mint of the other accounts.
   - Bump `CLOSE_AUDIT_VERSION` to 10 and run `closeAuditReauditSince` over the window.
   - Optional precision: charge the 5,000 lamports / 2 % relayer cut, if you want that last ◎0.0003.
3. **(i) Record / model fix — use the received SOL that actually landed. ◎0.014 / 30 d.**
   - `swapToken` should return the confirmed transaction's wallet SOL delta, plus the fee and any rent opened (the bot already fetches that transaction for `fetchTxFeeLamports`), or `outputAmountResult` net of `order.feeBps`, if Jupiter documents that is how it is applied.
   - Then `exit_slippage_sol` carries the fee.
   - Check whether `getSwapQuote`'s `out_amount` (exit-swap guard, close-efficiency shadow, net-cost exit estimate) is pre-fee too.
4. **(i) Record / model fix — add `exit_swap.gas_sol` to the modelled net. ◎0.0015.** In `recordExitSwapOutcome`: `pnl_sol − (total_gas_sol + exit_swap.gas_sol) − slippage`. Straddle-stage and mid-life transaction fees (◎0.0009) could be accumulated into `total_gas_sol` where those transactions are sent (`noteFlow` / straddle stages).
5. **(ii) Avoidable cost — register as a hypothesis, do not build. Is the straddle worth its entry premium?**
   - Entry premium: −◎0.0049 per straddle on average (0.69 % of capital, 1.4 % of the buy).
   - On the 15 straddled closes the wallet result is +◎0.0075 against +◎0.081 modelled.
   - A replay / grade should score the straddle lane on the wallet figure, or on modelled minus `entry_cost_sol`. Two levers to pre-register:
     - a tighter `harvestStraddleMaxImpactPct` (3 %) — the premium reaches 2.5 % of the buy;
     - not straddling when the pre-check quote's impact is above ~1 %.
   - Neither is tested here.
6. **(ii) Small avoidable cost — route-account churn: ≈ ◎0.0003 real cost / 30 d, plus temporarily parked rent (~◎0.04 at a time).** Restricting Jupiter routes (direct routes, or excluding intermediate tokens) might worsen fills by more. No action beyond recommendation 2 unless the third-party closer (`gasRUw…`) turns out to be unwanted — worth identifying in its own right, since it signs CloseAccount on the wallet's token accounts and keeps ≈ 2 % of the rent.
7. **(iii) No action:** two-sided and fee-token valuation timing (−◎0.005, sign follows the price path); pre-held-token sales (+◎0.003; fixable in the audit by ignoring sales of tokens the wallet held before the first position transaction, but small); exit price drift (zero); Token-2022 fees, bin-array / position rent, failed transactions (none or negligible).
8. **Dashboard copy:** the tooltip "what makes up the difference is not measured" (meridian-dashboard `public/analytics.js` `WALLET_VS_MODEL_TITLE`) can now name the parts: entry premium on two-sided positions, the Jupiter route fee, swap gas, and route-account rent the audit does not credit back.

After fixes 1–4, the modelled figure would fall by ≈ ◎0.084 and the wallet figure would rise by ≈ ◎0.044 (fix 2). The remaining difference would be the timing terms: ≈ ◎0.005 net over 85 closes, ≈ ◎0.00006 per close.

## 8. Limits

- **Sample size.** 38 of 85 bot closes were re-read on chain. They are chosen to cover 96 % of the gap, so the rates for the small closes rest on 6 of the 53 small closes plus the proxies.
- **Route-account rent outside the sample.** It is bounded by an argument, not measured: an un-offset ◎0.0015 account would make a close's |gap| ≥ ◎0.0005, and every such close is in the sample.
- **The 0.1 % Jupiter fee.** It is inferred from chain: the recorded output vs what landed, uniform 0.100 % on every SOL-quoted pump-style pair here. CLAUDE.md's 10-12 measurement had Jupiter's own fee at 2–10 bps by pair, so other pairs may differ. Whether `outputAmountResult` is pre-fee by Jupiter's definition is not confirmed from their docs.
- **The `gasRUw…` fee payer is not identified.**
- **Operator population.** Only 2 of 23 operator closes were read on chain.
- **The record's two-sided valuation term** depends on Meteora's per-event valuations, which I take as given.
- **Scope.** Records closed more than 30 days ago, and records audited by older versions, were not examined.
