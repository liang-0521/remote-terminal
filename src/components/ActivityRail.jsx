import {
  ArrowsLeftRight,
  ChartLine,
  Files,
  Gear,
  HardDrives,
  Terminal,
} from "@phosphor-icons/react";
import { IconButton } from "./IconButton.jsx";

const ITEMS = [
  { id: "connections", label: "服务器连接", Icon: HardDrives },
  { id: "files", label: "资源管理器", Icon: Files },
  { id: "sessions", label: "终端会话", Icon: Terminal },
  { id: "transfers", label: "传输任务", Icon: ArrowsLeftRight },
  { id: "monitor", label: "性能监控", Icon: ChartLine },
];

export function ActivityRail({ activeItem, settingsOpen, onChange, onOpenSettings }) {
  return (
    <nav className="activity-rail" aria-label="主功能">
      <div className="activity-rail__primary">
        {ITEMS.map(({ id, label, Icon }) => (
          <IconButton key={id} label={label} active={activeItem === id} onClick={() => onChange(id)}>
            <Icon size={25} weight={activeItem === id ? "duotone" : "regular"} />
          </IconButton>
        ))}
      </div>
      <IconButton label="设置" active={settingsOpen} onClick={onOpenSettings}>
        <Gear size={24} />
      </IconButton>
    </nav>
  );
}
