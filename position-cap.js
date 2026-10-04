// position-cap.js — how many open positions count against risk.maxPositions.
//
// `maxPositionsExcludeHold` (Telegram: "Excl HOLD from Max Pos") leaves held positions out of
// the count. The screener honoured it but the executor's deploy check counted every position,
// so with the toggle on the screener saw free slots the executor then refused. One function for
// every site keeps them in agreement.
export function countPositionsTowardCap(positions, { excludeHold = false, isHeld = () => false } = {}) {
  const list = Array.isArray(positions) ? positions : [];
  if (!excludeHold) return list.length;
  return list.filter((p) => p?.hold_mode !== true && isHeld(p?.position) !== true).length;
}
