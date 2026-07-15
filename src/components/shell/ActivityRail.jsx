import { useEffect, useRef, useState } from "react";
import {
  ArrowsLeftRight,
  ChartLine,
  Desktop,
  Files,
  Gear,
  HardDrives,
  Moon,
  Sun,
  Terminal,
} from "@phosphor-icons/react";
import { IconButton } from "../shared/IconButton.jsx";

const ITEMS = [
  { id: "connections", label: "服务器连接", Icon: HardDrives },
  { id: "files", label: "资源管理器", Icon: Files },
  { id: "sessions", label: "终端会话", Icon: Terminal },
  { id: "transfers", label: "传输任务", Icon: ArrowsLeftRight },
  { id: "monitor", label: "性能监控", Icon: ChartLine },
];

const THEME_OPTIONS = [
  { id: "system", label: "跟随系统", Icon: Desktop },
  { id: "light", label: "亮色", Icon: Sun },
  { id: "dark", label: "暗色", Icon: Moon },
];

export function ActivityRail({ activeItem, expanded, settingsOpen, themeMode, onChange, onThemeModeChange, onOpenSettings }) {
  const [themeMenuOpen, setThemeMenuOpen] = useState(false);
  const themeShellRef = useRef(null);
  const themeTriggerRef = useRef(null);
  const themeOptionRefs = useRef([]);
  const activeTheme = THEME_OPTIONS.find((option) => option.id === themeMode) || THEME_OPTIONS[0];
  const ThemeIcon = activeTheme.Icon;

  useEffect(() => {
    if (!themeMenuOpen) return undefined;
    const closeOnOutsidePointer = (event) => {
      if (!themeShellRef.current?.contains(event.target)) setThemeMenuOpen(false);
    };
    document.addEventListener("pointerdown", closeOnOutsidePointer);
    const frame = window.requestAnimationFrame(() => {
      const activeIndex = Math.max(0, THEME_OPTIONS.findIndex((option) => option.id === themeMode));
      themeOptionRefs.current[activeIndex]?.focus();
    });
    return () => {
      document.removeEventListener("pointerdown", closeOnOutsidePointer);
      window.cancelAnimationFrame(frame);
    };
  }, [themeMenuOpen, themeMode]);

  useEffect(() => {
    if (settingsOpen) setThemeMenuOpen(false);
  }, [settingsOpen]);

  function selectTheme(mode) {
    onThemeModeChange(mode);
    setThemeMenuOpen(false);
    window.requestAnimationFrame(() => themeTriggerRef.current?.focus());
  }

  function handleThemeMenuKeyDown(event, currentIndex) {
    if (event.key === "Escape") {
      event.preventDefault();
      setThemeMenuOpen(false);
      window.requestAnimationFrame(() => themeTriggerRef.current?.focus());
      return;
    }
    if (!["ArrowUp", "ArrowDown", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    const nextIndex = event.key === "Home"
      ? 0
      : event.key === "End"
        ? THEME_OPTIONS.length - 1
        : (currentIndex + (event.key === "ArrowDown" ? 1 : -1) + THEME_OPTIONS.length) % THEME_OPTIONS.length;
    themeOptionRefs.current[nextIndex]?.focus();
  }

  return (
    <nav className={`activity-rail ${expanded ? "is-expanded" : ""}`} aria-label="主功能">
      <div className="activity-rail__primary">
        {ITEMS.map(({ id, label, Icon }) => (
          <IconButton key={id} label={label} active={activeItem === id} onClick={() => onChange(id)}>
            <Icon size={25} weight={activeItem === id ? "duotone" : "regular"} />
            <span className="activity-rail__label">{label}</span>
          </IconButton>
        ))}
      </div>
      <div className="activity-rail__secondary">
        <div ref={themeShellRef} className="activity-rail__theme">
          <IconButton
            ref={themeTriggerRef}
            label={`界面主题：${activeTheme.label}`}
            active={themeMenuOpen}
            aria-haspopup="menu"
            aria-expanded={themeMenuOpen}
            onClick={() => setThemeMenuOpen((open) => !open)}
          >
            <ThemeIcon size={23} />
            <span className="activity-rail__label">界面主题</span>
          </IconButton>
          {themeMenuOpen && (
            <div className="activity-rail__theme-menu" role="menu" aria-label="界面主题">
              {THEME_OPTIONS.map(({ id, label, Icon }, index) => (
                <button
                  ref={(element) => { themeOptionRefs.current[index] = element; }}
                  key={id}
                  type="button"
                  role="menuitemradio"
                  aria-checked={themeMode === id}
                  onClick={() => selectTheme(id)}
                  onKeyDown={(event) => handleThemeMenuKeyDown(event, index)}
                >
                  <Icon size={18} />
                  <span>{label}</span>
                  <i aria-hidden="true" />
                </button>
              ))}
            </div>
          )}
        </div>
        <IconButton label="设置" active={settingsOpen} onClick={onOpenSettings}>
          <Gear size={24} />
          <span className="activity-rail__label">设置</span>
        </IconButton>
      </div>
    </nav>
  );
}
