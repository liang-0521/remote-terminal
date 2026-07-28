export const MIN_BOTTOM_PANEL_HEIGHT = 120;
export const MIN_TERMINAL_CONTENT_HEIGHT = 72;

export function calculateBottomPanelMaxHeight({
  workbenchHeight,
  terminalTabsHeight,
  statusBarHeight,
  minPanelHeight = MIN_BOTTOM_PANEL_HEIGHT,
  minTerminalContentHeight = MIN_TERMINAL_CONTENT_HEIGHT,
}) {
  const available = Math.floor(
    Number(workbenchHeight)
      - Number(terminalTabsHeight)
      - Number(statusBarHeight)
      - Number(minTerminalContentHeight),
  );
  if (!Number.isFinite(available)) return minPanelHeight;
  return Math.max(minPanelHeight, available);
}

export function clampBottomPanelHeight(
  height,
  maxHeight,
  minHeight = MIN_BOTTOM_PANEL_HEIGHT,
) {
  return Math.round(Math.min(maxHeight, Math.max(minHeight, Number(height) || minHeight)));
}
