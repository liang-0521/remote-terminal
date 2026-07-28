export const DEFAULT_APPEARANCE = Object.freeze({
  accent: "#9d84f8",
  terminalBackground: "#061423",
  terminalForeground: "#c8cbd1",
  terminalFontSize: 14,
  wallpaperOpacity: 0.22,
  wallpaperName: "",
  wallpaperUrl: "",
});

export function accentContrast(hexColor) {
  const match = /^#([\da-f]{2})([\da-f]{2})([\da-f]{2})$/i.exec(hexColor || "");
  if (!match) return "#ffffff";
  const [red, green, blue] = match.slice(1).map((channel) => Number.parseInt(channel, 16));
  const luminance = (0.2126 * red + 0.7152 * green + 0.0722 * blue) / 255;
  return luminance > 0.62 ? "#111827" : "#ffffff";
}
