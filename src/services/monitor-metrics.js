export function toMonitorPercent(used, total, label) {
  if (!Number.isFinite(used) || !Number.isFinite(total) || total <= 0) {
    throw new TypeError(`${label} 的已用量和总量必须是有效数字，且总量必须大于 0`);
  }
  return Math.min(100, Math.max(0, (used / total) * 100));
}
