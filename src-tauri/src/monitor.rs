use serde::Serialize;
use std::{
    collections::BTreeMap,
    error::Error,
    fmt::{self, Display, Formatter},
};

const KIBIBYTES_PER_MEBIBYTE: u64 = 1024;
const KIBIBYTES_PER_GIBIBYTE: u64 = 1024 * 1024;
const JAVASCRIPT_MAX_SAFE_INTEGER: u64 = 9_007_199_254_740_991;

pub const NETWORK_MARKER: &str = "@@REMOTE_TERMINAL:NETWORK_DEV@@";
pub const OS_MARKER: &str = "@@REMOTE_TERMINAL:OS@@";
pub const UPTIME_MARKER: &str = "@@REMOTE_TERMINAL:UPTIME@@";
pub const LOAD_MARKER: &str = "@@REMOTE_TERMINAL:LOAD@@";
pub const CPU_CORES_MARKER: &str = "@@REMOTE_TERMINAL:CPU_CORES@@";
pub const MEMORY_MARKER: &str = "@@REMOTE_TERMINAL:MEMORY@@";
pub const PROCESSES_MARKER: &str = "@@REMOTE_TERMINAL:PROCESSES@@";
pub const MOUNTS_MARKER: &str = "@@REMOTE_TERMINAL:MOUNTS@@";

pub const MONITOR_SECTION_MARKERS: [(&str, &str); 7] = [
    ("os", OS_MARKER),
    ("uptime", UPTIME_MARKER),
    ("load", LOAD_MARKER),
    ("cpuCores", CPU_CORES_MARKER),
    ("memory", MEMORY_MARKER),
    ("processes", PROCESSES_MARKER),
    ("mounts", MOUNTS_MARKER),
];

pub const COUNTER_COMMAND: &str = r#"export LC_ALL=C
sed -n '1p' /proc/stat
printf '%s\n' '@@REMOTE_TERMINAL:NETWORK_DEV@@'
cat /proc/net/dev"#;

// CPU and network counters are sampled separately. This command intentionally
// contains only point-in-time values so the SSH layer can run both operations
// concurrently after the first counter sample.
pub const MONITOR_SNAPSHOT_COMMAND: &str = r#"export LC_ALL=C
printf '%s\n' '@@REMOTE_TERMINAL:OS@@'
os_name=''
if [ -r /etc/os-release ]; then os_name=$(sed -n 's/^PRETTY_NAME=//p' /etc/os-release | sed 's/^"//;s/"$//' | sed -n '1p'); fi
if [ -z "$os_name" ]; then os_name=$(uname -sr); fi
printf '%s\n' "$os_name"
printf '%s\n' '@@REMOTE_TERMINAL:UPTIME@@'
cat /proc/uptime
printf '%s\n' '@@REMOTE_TERMINAL:LOAD@@'
cat /proc/loadavg
printf '%s\n' '@@REMOTE_TERMINAL:CPU_CORES@@'
getconf _NPROCESSORS_ONLN
printf '%s\n' '@@REMOTE_TERMINAL:MEMORY@@'
cat /proc/meminfo
printf '%s\n' '@@REMOTE_TERMINAL:PROCESSES@@'
ps -eo pid=,user=,pcpu=,rss=,args= --sort=-pcpu | sed -n '1,8p'
printf '%s\n' '@@REMOTE_TERMINAL:MOUNTS@@'
df -Pk | awk 'NR > 1 && $2 > 0 { mount=$6; for (i=7; i<=NF; i++) mount=mount " " $i; printf "%s\t%s\t%s\t%s\t%s\n", mount,$2,$3,$4,$5 }'"#;

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum MonitorError {
    EmptyInput(&'static str),
    InvalidFormat(String),
    InvalidRange(String),
    MissingSection(&'static str),
    DuplicateSection(&'static str),
    UnknownSection(String),
    ArithmeticOverflow(String),
}

impl Display for MonitorError {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> fmt::Result {
        match self {
            Self::EmptyInput(label) => write!(formatter, "{label} 必须是非空字符串"),
            Self::InvalidFormat(message)
            | Self::InvalidRange(message)
            | Self::ArithmeticOverflow(message) => formatter.write_str(message),
            Self::MissingSection(section) => write!(formatter, "缺少监控 section: {section}"),
            Self::DuplicateSection(section) => write!(formatter, "重复的监控 section: {section}"),
            Self::UnknownSection(marker) => {
                write!(formatter, "未知的监控 section marker: {marker}")
            }
        }
    }
}

impl Error for MonitorError {}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CpuCounters {
    pub user: u64,
    pub nice: u64,
    pub system: u64,
    pub idle: u64,
    pub iowait: u64,
    pub irq: u64,
    pub softirq: u64,
    pub steal: u64,
    pub total: u64,
    pub idle_total: u64,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NetworkCounters {
    pub received_bytes: u64,
    pub transmitted_bytes: u64,
}

pub type NetworkSample = BTreeMap<String, NetworkCounters>;

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CounterSnapshot {
    pub cpu: CpuCounters,
    pub network: NetworkSample,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NetworkRates {
    pub interface: String,
    pub down: f64,
    pub up: f64,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MonitorProcess {
    pub pid: u64,
    pub user: String,
    pub cpu: f64,
    pub memory: String,
    pub command: String,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MonitorMount {
    pub path: String,
    pub used: f64,
    pub available: f64,
    pub total: f64,
    pub used_label: String,
    pub available_label: String,
    pub total_label: String,
    /// The validated value reported by `df`; consumers must not recompute it
    /// from rounded display capacities.
    pub percent: u8,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MonitorSnapshot {
    pub os: String,
    pub uptime: String,
    pub load: [f64; 3],
    pub cpu_cores: u64,
    pub cpu: f64,
    pub memory_used: f64,
    pub memory_total: f64,
    pub swap_used: f64,
    pub swap_total: f64,
    pub processes: Vec<MonitorProcess>,
    pub network_interface: String,
    pub down: f64,
    pub up: f64,
    pub latency: Option<f64>,
    pub mounts: Vec<MonitorMount>,
}

pub fn parse_counters(text: &str) -> Result<CounterSnapshot, MonitorError> {
    assert_text(text, "monitor counters")?;
    let marker_index = text
        .find(NETWORK_MARKER)
        .ok_or_else(|| MonitorError::InvalidFormat("监控计数器缺少网络分隔标记".to_string()))?;
    let network_start = marker_index + NETWORK_MARKER.len();

    Ok(CounterSnapshot {
        cpu: parse_cpu_stat(&text[..marker_index])?,
        network: parse_network_dev(&text[network_start..])?,
    })
}

pub fn parse_cpu_stat(text: &str) -> Result<CpuCounters, MonitorError> {
    assert_text(text, "CPU stat")?;
    let cpu_line = text
        .split(['\n', '\r'])
        .find(|line| line.split_whitespace().next() == Some("cpu"))
        .ok_or_else(|| MonitorError::InvalidFormat("CPU stat 缺少 cpu 汇总行".to_string()))?;
    let fields: Vec<&str> = cpu_line.split_whitespace().skip(1).collect();
    if fields.len() < 4 {
        return Err(MonitorError::InvalidFormat(
            "CPU stat 的 cpu 汇总行字段不足".to_string(),
        ));
    }

    let counters = fields
        .iter()
        .map(|field| parse_nonnegative_safe_integer(field, "CPU tick"))
        .collect::<Result<Vec<_>, _>>()?;
    let mut primary = [0_u64; 8];
    for (index, value) in counters.iter().take(primary.len()).enumerate() {
        primary[index] = *value;
    }

    let total = primary.iter().try_fold(0_u64, |sum, value| {
        checked_safe_add(sum, *value, "CPU tick 总量超出安全整数范围")
    })?;
    let idle_total =
        checked_safe_add(primary[3], primary[4], "CPU idle tick 总量超出安全整数范围")?;

    Ok(CpuCounters {
        user: primary[0],
        nice: primary[1],
        system: primary[2],
        idle: primary[3],
        iowait: primary[4],
        irq: primary[5],
        softirq: primary[6],
        steal: primary[7],
        total,
        idle_total,
    })
}

pub fn calculate_cpu_usage(
    previous: &CpuCounters,
    current: &CpuCounters,
) -> Result<f64, MonitorError> {
    validate_cpu_sample(previous, "previous")?;
    validate_cpu_sample(current, "current")?;

    let total_delta = current
        .total
        .checked_sub(previous.total)
        .ok_or_else(|| MonitorError::InvalidRange("CPU 总 tick 必须随时间增加".to_string()))?;
    if total_delta == 0 {
        return Err(MonitorError::InvalidRange(
            "CPU 总 tick 必须随时间增加".to_string(),
        ));
    }
    let idle_delta = current
        .idle_total
        .checked_sub(previous.idle_total)
        .ok_or_else(|| MonitorError::InvalidRange("CPU idle tick 增量无效".to_string()))?;
    if idle_delta > total_delta {
        return Err(MonitorError::InvalidRange(
            "CPU idle tick 增量无效".to_string(),
        ));
    }

    Ok(round_to(
        ((total_delta - idle_delta) as f64 / total_delta as f64) * 100.0,
        1,
    ))
}

pub fn parse_network_dev(text: &str) -> Result<NetworkSample, MonitorError> {
    assert_text(text, "network dev")?;
    let mut interfaces = BTreeMap::new();

    for line in text.split(['\n', '\r']) {
        if !line.contains(':') {
            continue;
        }
        let (raw_name, raw_fields) = line.split_once(':').ok_or_else(|| {
            MonitorError::InvalidFormat(format!("无法解析 network dev 行: {}", line.trim()))
        })?;
        let name = raw_name.trim();
        let fields: Vec<&str> = raw_fields.split_whitespace().collect();
        if name.is_empty() || fields.len() < 16 {
            return Err(MonitorError::InvalidFormat(format!(
                "network dev 接口 {} 的字段不足",
                if name.is_empty() { "<empty>" } else { name }
            )));
        }
        let counters = fields
            .iter()
            .map(|field| parse_nonnegative_safe_integer(field, &format!("接口 {name} 计数器")))
            .collect::<Result<Vec<_>, _>>()?;
        interfaces.insert(
            name.to_string(),
            NetworkCounters {
                received_bytes: counters[0],
                transmitted_bytes: counters[8],
            },
        );
    }

    if interfaces.is_empty() {
        return Err(MonitorError::InvalidFormat(
            "network dev 未包含任何接口".to_string(),
        ));
    }
    Ok(interfaces)
}

pub fn calculate_network_rates(
    previous: &NetworkSample,
    current: &NetworkSample,
    elapsed_ms: f64,
) -> Result<NetworkRates, MonitorError> {
    validate_network_sample(previous, "previous")?;
    validate_network_sample(current, "current")?;
    if !elapsed_ms.is_finite() || elapsed_ms <= 0.0 {
        return Err(MonitorError::InvalidRange(
            "网络采样间隔必须大于 0 毫秒".to_string(),
        ));
    }

    #[derive(Debug)]
    struct Candidate<'a> {
        name: &'a str,
        received_delta: u64,
        transmitted_delta: u64,
        activity: u64,
        volume: u64,
    }

    let mut candidates = Vec::new();
    for (name, current_counters) in current {
        if name == "lo" {
            continue;
        }
        let Some(previous_counters) = previous.get(name) else {
            continue;
        };
        let received_delta = current_counters
            .received_bytes
            .checked_sub(previous_counters.received_bytes)
            .ok_or_else(|| {
                MonitorError::InvalidRange(format!("接口 {name} 的网络计数器发生回退"))
            })?;
        let transmitted_delta = current_counters
            .transmitted_bytes
            .checked_sub(previous_counters.transmitted_bytes)
            .ok_or_else(|| {
                MonitorError::InvalidRange(format!("接口 {name} 的网络计数器发生回退"))
            })?;
        // Each source counter is bounded by JavaScript's maximum safe integer.
        // Adding two such values cannot overflow u64 and mirrors the Electron
        // selector, which permits the combined ranking value to exceed 2^53-1.
        let activity = received_delta + transmitted_delta;
        let volume = current_counters.received_bytes + current_counters.transmitted_bytes;
        candidates.push(Candidate {
            name,
            received_delta,
            transmitted_delta,
            activity,
            volume,
        });
    }

    if candidates.is_empty() {
        return Err(MonitorError::InvalidFormat(
            "两次网络采样之间没有共同的非 loopback 接口".to_string(),
        ));
    }
    candidates.sort_by(|left, right| {
        right
            .activity
            .cmp(&left.activity)
            .then_with(|| right.volume.cmp(&left.volume))
            .then_with(|| left.name.cmp(right.name))
    });
    let selected = &candidates[0];
    let seconds = elapsed_ms / 1000.0;

    Ok(NetworkRates {
        interface: selected.name.to_string(),
        down: round_to(selected.received_delta as f64 / 1024.0 / seconds, 2),
        up: round_to(selected.transmitted_delta as f64 / 1024.0 / seconds, 2),
    })
}

pub fn parse_snapshot(
    text: &str,
    cpu: f64,
    network: &NetworkRates,
) -> Result<MonitorSnapshot, MonitorError> {
    if !cpu.is_finite() || !(0.0..=100.0).contains(&cpu) {
        return Err(MonitorError::InvalidRange(
            "CPU 使用率必须是 0–100 的有效数字".to_string(),
        ));
    }
    validate_network_rates(network)?;

    let sections = parse_sections(text)?;
    let memory = parse_memory_info(&sections.memory)?;
    let load = parse_load(&sections.load)?;
    let cpu_cores = parse_positive_integer(sections.cpu_cores.trim(), "CPU 核数")?;
    let uptime_seconds = sections
        .uptime
        .split_whitespace()
        .next()
        .ok_or_else(|| {
            MonitorError::InvalidFormat("uptime section 不包含有效的运行秒数".to_string())
        })?
        .parse::<f64>()
        .map_err(|_| {
            MonitorError::InvalidFormat("uptime section 不包含有效的运行秒数".to_string())
        })?;
    if !uptime_seconds.is_finite() || uptime_seconds < 0.0 {
        return Err(MonitorError::InvalidFormat(
            "uptime section 不包含有效的运行秒数".to_string(),
        ));
    }

    let os = sections.os.trim().to_string();
    if os.is_empty() {
        return Err(MonitorError::InvalidFormat(
            "os section 不能为空".to_string(),
        ));
    }

    Ok(MonitorSnapshot {
        os,
        uptime: format_uptime(uptime_seconds)?,
        load,
        cpu_cores,
        cpu,
        memory_used: to_gibibytes(memory.mem_total - memory.mem_available),
        memory_total: to_gibibytes(memory.mem_total),
        swap_used: to_gibibytes(memory.swap_total - memory.swap_free),
        swap_total: to_gibibytes(memory.swap_total),
        processes: parse_processes(&sections.processes)?,
        network_interface: network.interface.clone(),
        down: network.down,
        up: network.up,
        latency: None,
        mounts: parse_mounts(&sections.mounts)?,
    })
}

#[derive(Debug)]
struct Sections {
    os: String,
    uptime: String,
    load: String,
    cpu_cores: String,
    memory: String,
    processes: String,
    mounts: String,
}

fn parse_sections(text: &str) -> Result<Sections, MonitorError> {
    assert_text(text, "monitor snapshot")?;
    let normalized = text.replace("\r\n", "\n");
    let mut content: BTreeMap<&'static str, Vec<&str>> = BTreeMap::new();
    let mut current_section: Option<&'static str> = None;

    for line in normalized.split('\n') {
        if let Some((name, _)) = MONITOR_SECTION_MARKERS
            .iter()
            .find(|(_, marker)| *marker == line)
        {
            if content.contains_key(name) {
                return Err(MonitorError::DuplicateSection(name));
            }
            content.insert(name, Vec::new());
            current_section = Some(name);
            continue;
        }
        if line.starts_with("@@REMOTE_TERMINAL:") && line.ends_with("@@") {
            return Err(MonitorError::UnknownSection(line.to_string()));
        }
        let Some(section) = current_section else {
            if !line.trim().is_empty() {
                return Err(MonitorError::InvalidFormat(
                    "首个监控 section 之前存在意外输出".to_string(),
                ));
            }
            continue;
        };
        content
            .get_mut(section)
            .expect("current section is inserted before content")
            .push(line);
    }

    fn take_section(
        content: &BTreeMap<&'static str, Vec<&str>>,
        name: &'static str,
    ) -> Result<String, MonitorError> {
        let lines = content
            .get(name)
            .ok_or(MonitorError::MissingSection(name))?;
        Ok(lines.join("\n").trim_end().to_string())
    }

    Ok(Sections {
        os: take_section(&content, "os")?,
        uptime: take_section(&content, "uptime")?,
        load: take_section(&content, "load")?,
        cpu_cores: take_section(&content, "cpuCores")?,
        memory: take_section(&content, "memory")?,
        processes: take_section(&content, "processes")?,
        mounts: take_section(&content, "mounts")?,
    })
}

#[derive(Debug)]
struct MemoryInfo {
    mem_total: u64,
    mem_available: u64,
    swap_total: u64,
    swap_free: u64,
}

fn parse_memory_info(text: &str) -> Result<MemoryInfo, MonitorError> {
    let mut values = BTreeMap::new();
    for line in text.split(['\n', '\r']) {
        let Some((name, remainder)) = line.split_once(':') else {
            continue;
        };
        if name.is_empty()
            || !name
                .chars()
                .all(|character| character.is_ascii_alphabetic() || "_()".contains(character))
            || !remainder.chars().next().is_some_and(char::is_whitespace)
        {
            continue;
        }
        let fields: Vec<&str> = remainder.split_whitespace().collect();
        if fields.len() != 2 || fields[1] != "kB" || !is_ascii_digits(fields[0]) {
            continue;
        }
        values.insert(name, parse_nonnegative_safe_integer(fields[0], name)?);
    }

    let required_value = |name: &'static str| {
        values
            .get(name)
            .copied()
            .ok_or_else(|| MonitorError::InvalidFormat(format!("memory section 缺少 {name}")))
    };
    let memory = MemoryInfo {
        mem_total: required_value("MemTotal")?,
        mem_available: required_value("MemAvailable")?,
        swap_total: required_value("SwapTotal")?,
        swap_free: required_value("SwapFree")?,
    };
    if memory.mem_total == 0 || memory.mem_available > memory.mem_total {
        return Err(MonitorError::InvalidRange(
            "内存总量或可用量无效".to_string(),
        ));
    }
    if memory.swap_free > memory.swap_total {
        return Err(MonitorError::InvalidRange(
            "Swap 可用量不能大于总量".to_string(),
        ));
    }
    Ok(memory)
}

fn parse_load(text: &str) -> Result<[f64; 3], MonitorError> {
    let values = text
        .split_whitespace()
        .take(3)
        .map(|field| field.parse::<f64>())
        .collect::<Result<Vec<_>, _>>()
        .map_err(|_| {
            MonitorError::InvalidFormat("load section 必须包含三个非负负载值".to_string())
        })?;
    if values.len() != 3
        || values
            .iter()
            .any(|value| !value.is_finite() || *value < 0.0)
    {
        return Err(MonitorError::InvalidFormat(
            "load section 必须包含三个非负负载值".to_string(),
        ));
    }
    Ok([values[0], values[1], values[2]])
}

fn parse_processes(text: &str) -> Result<Vec<MonitorProcess>, MonitorError> {
    let lines: Vec<&str> = text
        .lines()
        .filter(|line| !line.trim().is_empty())
        .collect();
    if lines.is_empty() {
        return Err(MonitorError::InvalidFormat(
            "processes section 不能为空".to_string(),
        ));
    }

    lines
        .into_iter()
        .map(|line| {
            let (fields, command) = split_leading_fields(line, 4).ok_or_else(|| {
                MonitorError::InvalidFormat(format!("无法解析进程行: {}", line.trim()))
            })?;
            let pid = parse_positive_integer(fields[0], "进程 PID")?;
            if !is_unsigned_decimal(fields[2]) {
                return Err(MonitorError::InvalidFormat(format!(
                    "进程 {pid} CPU 使用率无效"
                )));
            }
            let cpu = fields[2]
                .parse::<f64>()
                .map_err(|_| MonitorError::InvalidFormat(format!("进程 {pid} CPU 使用率无效")))?;
            if !cpu.is_finite() || cpu < 0.0 {
                return Err(MonitorError::InvalidFormat(format!(
                    "进程 {pid} CPU 使用率无效"
                )));
            }
            let rss_kibibytes =
                parse_nonnegative_safe_integer(fields[3], &format!("进程 {pid} RSS"))?;

            Ok(MonitorProcess {
                pid,
                user: fields[1].to_string(),
                cpu,
                memory: format_memory(rss_kibibytes),
                command: command.to_string(),
            })
        })
        .collect()
}

fn parse_mounts(text: &str) -> Result<Vec<MonitorMount>, MonitorError> {
    let lines: Vec<&str> = text
        .lines()
        .filter(|line| !line.trim().is_empty())
        .collect();
    if lines.is_empty() {
        return Err(MonitorError::InvalidFormat(
            "mounts section 不能为空".to_string(),
        ));
    }

    lines
        .into_iter()
        .map(|line| {
            let fields: Vec<&str> = line.split('\t').collect();
            if fields.len() != 5 || fields[0].is_empty() {
                return Err(MonitorError::InvalidFormat(format!(
                    "无法解析挂载点行: {line}"
                )));
            }
            let path = fields[0];
            let total_kibibytes =
                parse_positive_integer(fields[1], &format!("挂载点 {path} 总量"))?;
            let used_kibibytes =
                parse_nonnegative_safe_integer(fields[2], &format!("挂载点 {path} 已用量"))?;
            let available_kibibytes =
                parse_nonnegative_safe_integer(fields[3], &format!("挂载点 {path} 可用量"))?;
            let raw_percent = fields[4]
                .strip_suffix('%')
                .ok_or_else(|| MonitorError::InvalidFormat(format!("挂载点 {path} 使用率无效")))?;
            if !is_ascii_digits(raw_percent) {
                return Err(MonitorError::InvalidFormat(format!(
                    "挂载点 {path} 使用率无效"
                )));
            }
            let percent = raw_percent
                .parse::<u8>()
                .map_err(|_| MonitorError::InvalidRange(format!("挂载点 {path} 使用率超出范围")))?;
            if percent > 100 {
                return Err(MonitorError::InvalidRange(format!(
                    "挂载点 {path} 使用率超出范围"
                )));
            }

            Ok(MonitorMount {
                path: path.to_string(),
                used: to_mount_gibibytes(used_kibibytes),
                available: to_mount_gibibytes(available_kibibytes),
                total: to_mount_gibibytes(total_kibibytes),
                used_label: format_capacity(used_kibibytes),
                available_label: format_capacity(available_kibibytes),
                total_label: format_capacity(total_kibibytes),
                percent,
            })
        })
        .collect()
}

fn validate_cpu_sample(sample: &CpuCounters, label: &str) -> Result<(), MonitorError> {
    if sample.total > JAVASCRIPT_MAX_SAFE_INTEGER || sample.idle_total > JAVASCRIPT_MAX_SAFE_INTEGER
    {
        return Err(MonitorError::InvalidFormat(format!("{label} CPU 样本无效")));
    }
    if sample.idle_total > sample.total {
        return Err(MonitorError::InvalidRange(format!(
            "{label} CPU 样本范围无效"
        )));
    }
    Ok(())
}

fn validate_network_sample(sample: &NetworkSample, label: &str) -> Result<(), MonitorError> {
    for (name, counters) in sample {
        if name.is_empty()
            || counters.received_bytes > JAVASCRIPT_MAX_SAFE_INTEGER
            || counters.transmitted_bytes > JAVASCRIPT_MAX_SAFE_INTEGER
        {
            return Err(MonitorError::InvalidFormat(format!(
                "{label} 接口 {} 计数器无效",
                if name.is_empty() { "<empty>" } else { name }
            )));
        }
    }
    Ok(())
}

fn validate_network_rates(network: &NetworkRates) -> Result<(), MonitorError> {
    if network.interface.trim().is_empty() {
        return Err(MonitorError::InvalidFormat(
            "网络速率缺少接口名称".to_string(),
        ));
    }
    if !network.down.is_finite()
        || network.down < 0.0
        || !network.up.is_finite()
        || network.up < 0.0
    {
        return Err(MonitorError::InvalidRange(
            "网络上下行速率必须是非负有效数字".to_string(),
        ));
    }
    Ok(())
}

fn parse_nonnegative_safe_integer(value: &str, label: &str) -> Result<u64, MonitorError> {
    if !is_ascii_digits(value) {
        return Err(MonitorError::InvalidFormat(format!(
            "{label} 必须是非负整数"
        )));
    }
    let number = value
        .parse::<u64>()
        .map_err(|_| MonitorError::InvalidRange(format!("{label} 超出安全整数范围")))?;
    if number > JAVASCRIPT_MAX_SAFE_INTEGER {
        return Err(MonitorError::InvalidRange(format!(
            "{label} 超出安全整数范围"
        )));
    }
    Ok(number)
}

fn parse_positive_integer(value: &str, label: &str) -> Result<u64, MonitorError> {
    let number = parse_nonnegative_safe_integer(value, label)?;
    if number == 0 {
        return Err(MonitorError::InvalidRange(format!("{label} 必须大于 0")));
    }
    Ok(number)
}

fn checked_safe_add(left: u64, right: u64, message: &str) -> Result<u64, MonitorError> {
    let sum = left
        .checked_add(right)
        .filter(|sum| *sum <= JAVASCRIPT_MAX_SAFE_INTEGER)
        .ok_or_else(|| MonitorError::ArithmeticOverflow(message.to_string()))?;
    Ok(sum)
}

fn assert_text(value: &str, label: &'static str) -> Result<(), MonitorError> {
    if value.trim().is_empty() {
        return Err(MonitorError::EmptyInput(label));
    }
    Ok(())
}

fn is_ascii_digits(value: &str) -> bool {
    !value.is_empty() && value.bytes().all(|byte| byte.is_ascii_digit())
}

fn is_unsigned_decimal(value: &str) -> bool {
    let mut parts = value.split('.');
    let Some(integer) = parts.next() else {
        return false;
    };
    if !is_ascii_digits(integer) {
        return false;
    }
    match (parts.next(), parts.next()) {
        (None, None) => true,
        (Some(fraction), None) => is_ascii_digits(fraction),
        _ => false,
    }
}

fn split_leading_fields(line: &str, field_count: usize) -> Option<(Vec<&str>, &str)> {
    let mut fields = Vec::with_capacity(field_count);
    let mut position = 0;

    while fields.len() < field_count {
        let remaining = line.get(position..)?;
        let leading = remaining
            .char_indices()
            .find(|(_, character)| !character.is_whitespace())
            .map(|(index, _)| index)?;
        let start = position + leading;
        let token = line.get(start..)?;
        let end = token
            .char_indices()
            .find(|(_, character)| character.is_whitespace())
            .map_or(line.len(), |(index, _)| start + index);
        fields.push(line.get(start..end)?);
        position = end;
    }

    let command = line.get(position..)?.trim();
    if command.is_empty() {
        return None;
    }
    Some((fields, command))
}

fn to_gibibytes(kibibytes: u64) -> f64 {
    round_to(kibibytes as f64 / KIBIBYTES_PER_GIBIBYTE as f64, 2)
}

fn to_mount_gibibytes(kibibytes: u64) -> f64 {
    round_to(kibibytes as f64 / KIBIBYTES_PER_GIBIBYTE as f64, 4)
}

fn format_capacity(kibibytes: u64) -> String {
    if kibibytes >= KIBIBYTES_PER_GIBIBYTE {
        return format!(
            "{} GB",
            format_capacity_number(kibibytes as f64 / KIBIBYTES_PER_GIBIBYTE as f64)
        );
    }
    if kibibytes >= KIBIBYTES_PER_MEBIBYTE {
        return format!(
            "{} MB",
            format_capacity_number(kibibytes as f64 / KIBIBYTES_PER_MEBIBYTE as f64)
        );
    }
    format!("{kibibytes} KB")
}

fn format_capacity_number(value: f64) -> String {
    let rounded = round_to(value, 1);
    if rounded.fract() == 0.0 {
        format!("{rounded:.0}")
    } else {
        format!("{rounded:.1}")
    }
}

fn format_memory(kibibytes: u64) -> String {
    if kibibytes >= KIBIBYTES_PER_GIBIBYTE {
        return format!("{:.1} GB", kibibytes as f64 / KIBIBYTES_PER_GIBIBYTE as f64);
    }
    if kibibytes >= KIBIBYTES_PER_MEBIBYTE {
        return format!("{:.1} MB", kibibytes as f64 / KIBIBYTES_PER_MEBIBYTE as f64);
    }
    format!("{kibibytes} KB")
}

fn format_uptime(seconds: f64) -> Result<String, MonitorError> {
    let whole_minutes = (seconds / 60.0).floor();
    if whole_minutes > u64::MAX as f64 {
        return Err(MonitorError::InvalidRange(
            "uptime section 的运行秒数超出范围".to_string(),
        ));
    }
    let whole_minutes = whole_minutes as u64;
    let days = whole_minutes / (24 * 60);
    let hours = (whole_minutes % (24 * 60)) / 60;
    let minutes = whole_minutes % 60;
    if days > 0 {
        return Ok(format!("{days} 天 {hours} 小时"));
    }
    if hours > 0 {
        return Ok(format!("{hours} 小时 {minutes} 分钟"));
    }
    Ok(format!("{minutes} 分钟"))
}

fn round_to(value: f64, digits: i32) -> f64 {
    let factor = 10_f64.powi(digits);
    ((value + f64::EPSILON) * factor).round() / factor
}

#[cfg(test)]
mod tests {
    use super::*;

    fn snapshot_fixture(mounts: &str) -> String {
        [
            OS_MARKER,
            "Ubuntu 24.04.1 LTS",
            UPTIME_MARKER,
            "176580.50 1234.00",
            LOAD_MARKER,
            "0.76 0.90 0.83 2/901 2210",
            CPU_CORES_MARKER,
            "8",
            MEMORY_MARKER,
            "MemTotal:        8388608 kB\nMemAvailable:    6291456 kB\nSwapTotal:       4194304 kB\nSwapFree:        3145728 kB",
            PROCESSES_MARKER,
            " 2481 www-data 4.3 2097152 java -jar app.jar\n 1836 mysql 2.8 1331200 mysqld",
            MOUNTS_MARKER,
            mounts,
        ]
        .join("\n")
    }

    fn network_dev(received: u64, transmitted: u64) -> String {
        format!(
            "Inter-|   Receive                                                |  Transmit\n face |bytes    packets errs drop fifo frame compressed multicast|bytes    packets errs drop fifo colls carrier compressed\n    lo: 100 1 0 0 0 0 0 0 100 1 0 0 0 0 0 0\nens160: {received} 10 0 0 0 0 0 0 {transmitted} 10 0 0 0 0 0 0"
        )
    }

    #[test]
    fn parses_two_counter_samples_and_complete_snapshot() {
        let previous = parse_counters(&format!(
            "cpu 100 0 100 800 0 0 0 0 0 0\n{NETWORK_MARKER}\n{}",
            network_dev(1_000, 2_000)
        ))
        .expect("previous counters");
        let current = parse_counters(&format!(
            "cpu 150 0 150 900 0 0 0 0 0 0\n{NETWORK_MARKER}\n{}",
            network_dev(103_400, 53_200)
        ))
        .expect("current counters");
        let cpu = calculate_cpu_usage(&previous.cpu, &current.cpu).expect("CPU rate");
        let network = calculate_network_rates(&previous.network, &current.network, 1_000.0)
            .expect("network rates");
        let snapshot = parse_snapshot(
            &snapshot_fixture(
                "/\t104857600\t52428800\t52428800\t50%\n/boot\t1048576\t314572\t734004\t30%",
            ),
            cpu,
            &network,
        )
        .expect("monitor snapshot");

        assert_eq!(cpu, 50.0);
        assert_eq!(network.interface, "ens160");
        assert_eq!(network.down, 100.0);
        assert_eq!(network.up, 50.0);
        assert_eq!(snapshot.os, "Ubuntu 24.04.1 LTS");
        assert_eq!(snapshot.uptime, "2 天 1 小时");
        assert_eq!(snapshot.load, [0.76, 0.9, 0.83]);
        assert_eq!(snapshot.cpu_cores, 8);
        assert_eq!(snapshot.memory_used, 2.0);
        assert_eq!(snapshot.memory_total, 8.0);
        assert_eq!(snapshot.swap_used, 1.0);
        assert_eq!(snapshot.swap_total, 4.0);
        assert_eq!(snapshot.processes[0].memory, "2.0 GB");
        assert_eq!(snapshot.processes[0].command, "java -jar app.jar");
        assert_eq!(snapshot.mounts[1].used_label, "307.2 MB");
        assert_eq!(snapshot.mounts[1].available_label, "716.8 MB");
        assert_eq!(snapshot.mounts[1].total_label, "1 GB");
        assert!(MONITOR_SNAPSHOT_COMMAND.contains(MEMORY_MARKER));
        assert!(COUNTER_COMMAND.contains(NETWORK_MARKER));
    }

    #[test]
    fn preserves_small_mount_labels_and_df_percentage_as_truth() {
        let network = NetworkRates {
            interface: "eth0".to_string(),
            down: 0.0,
            up: 0.0,
        };
        let snapshot = parse_snapshot(
            &snapshot_fixture(
                "/\t104857600\t52428800\t52428800\t50%\n/run/lock\t5120\t512\t3584\t13%",
            ),
            12.5,
            &network,
        )
        .expect("small mount snapshot");
        let mount = &snapshot.mounts[1];

        assert_eq!(mount.path, "/run/lock");
        assert_eq!(mount.used, 0.0005);
        assert_eq!(mount.available, 0.0034);
        assert_eq!(mount.total, 0.0049);
        assert_eq!(mount.used_label, "512 KB");
        assert_eq!(mount.available_label, "3.5 MB");
        assert_eq!(mount.total_label, "5 MB");
        assert_eq!(mount.percent, 13);
        assert_ne!(
            mount.percent as f64,
            (mount.used / mount.total * 100.0).round()
        );
    }

    #[test]
    fn selects_most_active_shared_non_loopback_interface() {
        let previous = parse_network_dev(
            "lo: 10 0 0 0 0 0 0 0 10 0 0 0 0 0 0 0\neth0: 1000 0 0 0 0 0 0 0 1000 0 0 0 0 0 0 0\neth1: 5000 0 0 0 0 0 0 0 5000 0 0 0 0 0 0 0",
        )
        .expect("previous network");
        let current = parse_network_dev(
            "lo: 10000 0 0 0 0 0 0 0 10000 0 0 0 0 0 0 0\neth0: 2024 0 0 0 0 0 0 0 2024 0 0 0 0 0 0 0\neth1: 5200 0 0 0 0 0 0 0 5200 0 0 0 0 0 0 0",
        )
        .expect("current network");

        let rates = calculate_network_rates(&previous, &current, 1_000.0).expect("rates");
        assert_eq!(rates.interface, "eth0");
        assert_eq!(rates.down, 1.0);
        assert_eq!(rates.up, 1.0);
    }

    #[test]
    fn rejects_counter_regression_and_missing_counter_marker() {
        let previous_cpu = parse_cpu_stat("cpu 1 0 1 8 0 0 0 0").expect("previous CPU");
        let regressed_cpu = parse_cpu_stat("cpu 1 0 1 7 0 0 0 0").expect("regressed CPU");
        let error = calculate_cpu_usage(&previous_cpu, &regressed_cpu)
            .expect_err("CPU counter regression must fail");
        assert!(error.to_string().contains("CPU 总 tick 必须随时间增加"));

        let previous = parse_network_dev(&network_dev(2_000, 2_000)).expect("previous network");
        let current = parse_network_dev(&network_dev(1_000, 3_000)).expect("current network");
        let error = calculate_network_rates(&previous, &current, 1_000.0)
            .expect_err("counter regression must fail");
        assert!(error.to_string().contains("网络计数器发生回退"));

        let error = parse_counters("cpu 1 0 1 8 0 0 0 0\neth0: 1 0 0 0 0 0 0 0 1 0 0 0 0 0 0 0")
            .expect_err("missing counter marker must fail");
        assert_eq!(error.to_string(), "监控计数器缺少网络分隔标记");
    }

    #[test]
    fn rejects_missing_duplicate_and_unknown_snapshot_markers() {
        let network = NetworkRates {
            interface: "eth0".to_string(),
            down: 0.0,
            up: 0.0,
        };
        let fixture = snapshot_fixture("/\t1024\t512\t512\t50%");
        let missing = fixture.replace(&format!("{MEMORY_MARKER}\n"), "");
        let error =
            parse_snapshot(&missing, 10.0, &network).expect_err("missing section marker must fail");
        assert_eq!(error, MonitorError::MissingSection("memory"));

        let duplicate = format!("{fixture}\n{OS_MARKER}\nsecond os");
        let error = parse_snapshot(&duplicate, 10.0, &network)
            .expect_err("duplicate section marker must fail");
        assert_eq!(error, MonitorError::DuplicateSection("os"));

        let unknown = fixture.replace(OS_MARKER, "@@REMOTE_TERMINAL:UNKNOWN@@");
        let error =
            parse_snapshot(&unknown, 10.0, &network).expect_err("unknown section marker must fail");
        assert_eq!(
            error,
            MonitorError::UnknownSection("@@REMOTE_TERMINAL:UNKNOWN@@".to_string())
        );
    }

    #[test]
    fn rejects_malformed_cpu_and_preserves_zero_swap() {
        let error = parse_cpu_stat("cpu invalid 0 0 0").expect_err("invalid tick must fail");
        assert!(error.to_string().contains("CPU tick 必须是非负整数"));

        let network = NetworkRates {
            interface: "eth0".to_string(),
            down: 0.0,
            up: 0.0,
        };
        let fixture = snapshot_fixture("/\t1024\t512\t512\t50%")
            .replace("SwapTotal:       4194304 kB", "SwapTotal:       0 kB")
            .replace("SwapFree:        3145728 kB", "SwapFree:        0 kB");
        let snapshot = parse_snapshot(&fixture, 12.5, &network).expect("zero swap snapshot");
        assert_eq!(snapshot.swap_total, 0.0);
        assert_eq!(snapshot.swap_used, 0.0);
    }
}
