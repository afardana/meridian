/**
 * ledger_truth_audit.js — daily wallet-truth vs ledger table over an arbitrary window.
 * READ-ONLY. Run on the VM (pg backend):
 *   node scripts/ledger_truth_audit.js --since 2026-08-22T11:00Z [--until 2026-09-24T00:00Z] [--step 24]
 * Prints per-step: AUM start/end, flows, book, ledger, Δunrealized, drift — and the
 * window total. drift ≈ 0 means the perf ledger agrees with the wallet for that span.
 */
import "../envcrypt.js";
import { initState } from "../state.js";
import { initAllDocStores } from "../db/doc-store.js";
import { computeLedgerTruth } from "../ledger-truth.js";

const arg = (k, d) => { const i = process.argv.indexOf(`--${k}`); return i > -1 ? process.argv[i + 1] : d; };
const since = new Date(arg("since", new Date(Date.now() - 7 * 864e5).toISOString()));
const until = new Date(arg("until", new Date().toISOString()));
const stepH = Number(arg("step", 24));

await initState();
await initAllDocStores();

const f = (v) => (v == null ? "   n/a" : `${v >= 0 ? "+" : ""}${Number(v).toFixed(3)}`.padStart(7));
console.log(`window ${since.toISOString()} → ${until.toISOString()} step ${stepH}h`);
console.log("end                 aum_s   aum_e     dep   wdraw    book  ledger Δunreal   drift  closes");
let tot = { book: 0, ledger: 0, dU: 0, drift: 0, closes: 0 };
for (let t = since.getTime() + stepH * 3600e3; t <= until.getTime() + 1; t += stepH * 3600e3) {
  const end = new Date(Math.min(t, until.getTime()));
  const r = await computeLedgerTruth({ hours: stepH, end });
  if (!r) { console.log(`${end.toISOString().slice(0, 16)}  (no data)`); continue; }
  console.log(`${end.toISOString().slice(0, 16)} ${f(r.aum_start)} ${f(r.aum_end)} ${f(r.deposits)} ${f(r.withdrawals)} ${f(r.book)} ${f(r.ledger_net)} ${f(r.unrealized_delta)} ${f(r.drift)}  ${String(r.closes).padStart(4)}`);
  tot.book += r.book; tot.ledger += r.ledger_net; tot.dU += r.unrealized_delta; tot.drift += r.drift; tot.closes += r.closes;
}
console.log(`TOTAL                                              ${f(tot.book)} ${f(tot.ledger)} ${f(tot.dU)} ${f(tot.drift)}  ${String(tot.closes).padStart(4)}`);
const whole = await computeLedgerTruth({ hours: (until - since) / 3600e3, end: until });
if (whole) console.log(`WHOLE-WINDOW                                       ${f(whole.book)} ${f(whole.ledger_net)} ${f(whole.unrealized_delta)} ${f(whole.drift)}  ${String(whole.closes).padStart(4)}  (${whole.adopted_lifetime_scored} adopted records lifetime-scored)`);
process.exit(0);
