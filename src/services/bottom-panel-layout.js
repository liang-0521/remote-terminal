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

export function observeBottomPanelLayout(panel, onMeasure, {
  ResizeObserver: ResizeObserverClass = globalThis.ResizeObserver,
  MutationObserver: MutationObserverClass = globalThis.MutationObserver,
} = {}) {
  const workbench = panel.closest(".workbench");
  let terminalTabs = null;
  let statusBar = null;
  const resizeObserver = new ResizeObserverClass(measure);
  const childObserver = new MutationObserverClass(measure);

  function measure() {
    const nextTabs = workbench?.querySelector(".terminal-pane > .native-workspace-tab-row") || null;
    const nextStatus = workbench?.querySelector(".status-bar") || null;
    if (terminalTabs !== nextTabs) {
      if (terminalTabs) resizeObserver.unobserve(terminalTabs);
      terminalTabs = nextTabs;
      if (terminalTabs) resizeObserver.observe(terminalTabs);
    }
    if (statusBar !== nextStatus) {
      if (statusBar) resizeObserver.unobserve(statusBar);
      statusBar = nextStatus;
      if (statusBar) resizeObserver.observe(statusBar);
    }
    onMeasure({
      height: panel.offsetHeight,
      maxHeight: calculateBottomPanelMaxHeight({
        workbenchHeight: workbench?.clientHeight,
        terminalTabsHeight: terminalTabs?.offsetHeight || 0,
        statusBarHeight: statusBar?.offsetHeight || 0,
      }),
    });
  }

  resizeObserver.observe(panel);
  if (workbench) {
    resizeObserver.observe(workbench);
    // Suspense can replace the terminal placeholder after this panel mounts.
    // Observe direct workspace children, not terminal output or monitor updates.
    childObserver.observe(workbench, { childList: true });
  }
  measure();
  return () => {
    resizeObserver.disconnect();
    childObserver.disconnect();
  };
}
