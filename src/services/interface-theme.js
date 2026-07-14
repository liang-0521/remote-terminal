export const INTERFACE_THEME_MODES = Object.freeze(["system", "light", "dark"]);

export function resolveInterfaceColorScheme(mode, prefersDark) {
  if (!INTERFACE_THEME_MODES.includes(mode)) {
    throw new TypeError(`不支持的界面主题模式：${mode}`);
  }
  if (mode === "system") return prefersDark ? "dark" : "light";
  return mode;
}
