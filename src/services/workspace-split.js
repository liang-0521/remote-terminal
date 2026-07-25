export function workspaceTabKey(type, id) {
  return `${type}:${id}`;
}

export function reconcileSecondaryTabKey(secondaryTabKey, tabKeys, activeTabKey) {
  if (!secondaryTabKey || secondaryTabKey === activeTabKey) return null;
  return tabKeys.includes(secondaryTabKey) ? secondaryTabKey : null;
}

export function resolveWorkspaceSplit(tabKey, tabKeys, activeTabKey) {
  if (!tabKey || !tabKeys.includes(tabKey) || tabKeys.length < 2) return null;
  if (tabKey !== activeTabKey) {
    return { primaryTabKey: activeTabKey, secondaryTabKey: tabKey };
  }
  const primaryTabKey = tabKeys.find((key) => key !== tabKey);
  return primaryTabKey ? { primaryTabKey, secondaryTabKey: tabKey } : null;
}
