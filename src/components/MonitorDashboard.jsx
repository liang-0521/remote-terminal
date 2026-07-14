import {
  ArrowDown,
  ArrowUp,
  ArrowsDownUp,
  Clock,
  Cpu,
  DesktopTower,
  Gauge,
  HardDrive,
  Memory,
  Network,
} from "@phosphor-icons/react";
import {
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

export function MonitorDashboard({ server, metrics, sampledAt, loading = false, error = "" }) {
  if (!metrics) {
    return (
      <div className="monitor-dashboard monitor-dashboard--empty" role="status">
        <Gauge size={26} weight="duotone" />
        <strong>{loading ? "正在采集 Linux 性能数据…" : "暂无性能数据"}</strong>
        <span>{error || "建立 SSH 连接后会开始真实采样。"}</span>
      </div>
    );
  }

  const memoryPercent = toPercent(metrics.memoryUsed, metrics.memoryTotal, "内存");
  const swapPercent = metrics.swapTotal === 0 ? 0 : toPercent(metrics.swapUsed, metrics.swapTotal, "Swap");
  const processes = Array.isArray(metrics.processes) ? metrics.processes : [];
  const mounts = Array.isArray(metrics.mounts) ? metrics.mounts : [];
  const history = Array.isArray(metrics.history) ? metrics.history : [];

  return (
    <div className="monitor-dashboard">
      <section className="monitor-dashboard__region monitor-dashboard__region--system" aria-label="系统信息">
        <RegionHeader icon={<DesktopTower size={18} />} title="系统概览" meta={loading ? "正在刷新" : `采样于 ${sampledAt}`} />
        {error && <div className="monitor-dashboard__warning" role="alert">{error}，当前显示上一次成功采样。</div>}
        <dl className="monitor-dashboard__facts">
          <Fact label="服务器" value={server.endpoint} />
          <Fact label="系统" value={metrics.os} />
          <Fact label="运行时间" value={metrics.uptime} icon={<Clock size={14} />} />
          <Fact label="系统负载" value={metrics.load.join(" / ")} icon={<Gauge size={14} />} />
          <Fact label="CPU 核数" value={`${metrics.cpuCores} 核`} icon={<Cpu size={14} />} />
        </dl>
        <div className="monitor-dashboard__usage-list">
          <ResourceUsage label="CPU" value={metrics.cpu} detail={`${metrics.cpu}%`} icon={<Cpu size={16} />} />
          <ResourceUsage
            label="内存"
            value={memoryPercent}
            detail={`${metrics.memoryUsed} / ${metrics.memoryTotal} GB`}
            icon={<Memory size={16} />}
          />
          <ResourceUsage
            label="Swap"
            value={swapPercent}
            detail={`${metrics.swapUsed} / ${metrics.swapTotal} GB`}
            icon={<ArrowsDownUp size={16} />}
          />
        </div>
      </section>

      <section className="monitor-dashboard__region monitor-dashboard__region--processes" aria-label="进程信息">
        <RegionHeader icon={<Cpu size={18} />} title="进程信息" meta={`Top ${processes.length}`} />
        <div className="monitor-dashboard__table-wrap">
          <table className="monitor-dashboard__table monitor-dashboard__table--processes">
            <thead>
              <tr><th>PID</th><th>命令</th><th>CPU</th><th>内存</th></tr>
            </thead>
            <tbody>
              {processes.map((process) => (
                <tr key={process.pid}>
                  <td>{process.pid}</td>
                  <td title={process.command}>{process.command}</td>
                  <td>{process.cpu}%</td>
                  <td>{process.memory}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section className="monitor-dashboard__region monitor-dashboard__region--network" aria-label="网络信息">
        <RegionHeader icon={<Network size={18} />} title="网络信息" meta={metrics.networkInterface} />
        <div className="monitor-dashboard__network-summary">
          <span className="monitor-dashboard__rate monitor-dashboard__rate--down"><ArrowDown size={14} /> {metrics.down.toFixed(1)} KB/s</span>
          <span className="monitor-dashboard__rate monitor-dashboard__rate--up"><ArrowUp size={14} /> {metrics.up.toFixed(1)} KB/s</span>
          {Number.isFinite(metrics.latency) && <span className="monitor-dashboard__latency">延迟 {metrics.latency} ms</span>}
        </div>
        <div className="monitor-dashboard__chart" aria-label="网络上下行趋势图">
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={history} margin={{ top: 8, right: 10, bottom: 0, left: -18 }}>
              <CartesianGrid stroke="var(--border-default)" strokeDasharray="3 3" vertical={false} />
              <XAxis dataKey="time" minTickGap={28} tick={{ fill: "var(--text-muted)", fontSize: 11 }} tickLine={false} axisLine={false} />
              <YAxis tick={{ fill: "var(--text-muted)", fontSize: 11 }} tickLine={false} axisLine={false} width={42} />
              <Tooltip
                formatter={(value, name) => [`${Number(value).toFixed(1)} KB/s`, name]}
                contentStyle={{ background: "var(--bg-elevated)", border: "1px solid var(--border-strong)", borderRadius: 6 }}
                labelStyle={{ color: "var(--text-secondary)" }}
              />
              <Line type="monotone" dataKey="down" name="下载" stroke="var(--success)" strokeWidth={2} dot={false} isAnimationActive={false} />
              <Line type="monotone" dataKey="up" name="上传" stroke="var(--link)" strokeWidth={2} dot={false} isAnimationActive={false} />
            </LineChart>
          </ResponsiveContainer>
        </div>
      </section>

      <section className="monitor-dashboard__region monitor-dashboard__region--disks" aria-label="磁盘信息">
        <RegionHeader icon={<HardDrive size={18} />} title="磁盘信息" meta={`${mounts.length} 个挂载点`} />
        <div className="monitor-dashboard__table-wrap">
          <table className="monitor-dashboard__table monitor-dashboard__table--mounts">
            <thead>
              <tr><th>挂载点</th><th>已用</th><th>总量</th><th>使用率</th></tr>
            </thead>
            <tbody>
              {mounts.map((mount) => {
                const percent = toPercent(mount.used, mount.total, `挂载点 ${mount.path}`);
                return (
                  <tr key={mount.path}>
                    <td title={mount.path}>{mount.path}</td>
                    <td>{mount.usedLabel || formatCapacity(mount.used)}</td>
                    <td>{mount.totalLabel || formatCapacity(mount.total)}</td>
                    <td>
                      <span className="monitor-dashboard__disk-usage">
                        <progress max="100" value={percent} aria-label={`${mount.path} 使用率`} />
                        <b>{Math.round(percent)}%</b>
                      </span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}

function RegionHeader({ icon, title, meta }) {
  return (
    <header className="monitor-dashboard__region-header">
      <span className="monitor-dashboard__region-title">{icon}<strong>{title}</strong></span>
      <small>{meta}</small>
    </header>
  );
}

function Fact({ label, value, icon }) {
  return (
    <div className="monitor-dashboard__fact">
      <dt>{icon}{label}</dt>
      <dd>{value}</dd>
    </div>
  );
}

function ResourceUsage({ label, value, detail, icon }) {
  return (
    <div className="monitor-dashboard__usage">
      <span className="monitor-dashboard__usage-copy">{icon}<strong>{label}</strong><small>{detail}</small></span>
      <progress max="100" value={value} aria-label={`${label} 使用率`} />
    </div>
  );
}

function toPercent(used, total, label) {
  if (!Number.isFinite(used) || !Number.isFinite(total) || total <= 0) {
    throw new TypeError(`${label} 的已用量和总量必须是有效数字，且总量必须大于 0`);
  }
  return Math.min(100, Math.max(0, (used / total) * 100));
}

function formatCapacity(value) {
  const numericValue = Number(value);
  return `${numericValue.toFixed(Number.isInteger(numericValue) ? 0 : 1)} GB`;
}
