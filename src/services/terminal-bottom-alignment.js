export function calculateTerminalBottomOffsetRows(buffer, rows) {
  if (
    !buffer
    || buffer.type !== "normal"
    || !Number.isInteger(rows)
    || rows <= 0
    || buffer.viewportY !== buffer.baseY
  ) {
    return 0;
  }

  const cursorRow = Math.min(rows - 1, Math.max(0, Number(buffer.cursorY) || 0));
  let anchorRow = cursorRow;
  for (let row = rows - 1; row >= 0; row -= 1) {
    const line = buffer.getLine(buffer.viewportY + row);
    if (line?.translateToString(true)) {
      anchorRow = Math.max(anchorRow, row);
      break;
    }
  }
  return Math.max(0, rows - 1 - anchorRow);
}
