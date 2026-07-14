# Remote Terminal

> **纯 AI 开发项目**：产品定义、界面设计、编码、测试、打包和发布全流程均由 AI 完成。

Windows → Linux 远程服务器桌面客户端。当前 `0.1.0` 已从界面原型进入可用原生客户端阶段：Electron 主进程通过 `ssh2` 提供真实 SSH、SFTP 与免 Agent 性能采集，浏览器直接打开时仍保留显式模拟原型。

## 0.1.0 已实现

- 连接管理器与清晰的新增服务器入口；每台服务器打开为独立工作区，切换后保留各自终端、远程目录、传输和监控状态，连接配置支持二次确认删除。
- 密码 SSH、`xterm-256color` 交互终端、PTY 尺寸同步、首次主机指纹确认与指纹变化硬阻断。用户名默认 `root`；保存密码默认关闭，用户主动选择后仅在认证成功时通过当前 Windows 用户的 `safeStorage` 加密，且与连接配置分离。
- 本地命令模板：点击“命令模板”或按 `Ctrl+Shift+P`（兼容 `Ctrl+Space`）搜索常用 Linux 命令；`Enter`/`Tab` 只替换当前 Shell 命令行，不自动执行，也不采集终端输入。
- 终端键位遵循常见约定：`Ctrl+C` 在有选区时复制、无选区时向远端发送中断，`Ctrl+Shift+C/V` 复制或粘贴；工作区和菜单支持方向键、Home/End、Escape 等键盘操作。
- SFTP 目录浏览与文件列表直接拖拽上传；支持多文件、进度、取消、重试、临时文件原子落盘和目标存在时拒绝覆盖。单会话最多同时上传 3 个文件。
- 顶部仅展示 CPU、内存和 Swap 摘要；底部监控展示系统/负载、逻辑核数、进程、网络趋势和文件系统容量。采集失败会明确显示，不伪造数据。
- 可垂直调整、收起和关闭的底部面板；左下角固定设置入口；强调色、终端配色和背景图片在当前客户端会话中生效。
- Electron 安全边界：沙箱、上下文隔离、最小预加载桥、IPC 来源校验、权限与新窗口拒绝、单实例运行、渲染进程退出时清理 SSH 会话。
- Windows NSIS 安装包与 GitHub Releases 自动更新：后台检查和下载，设置中展示进度，用户确认重启后安装；活动 SFTP 上传会在界面和主进程双重阻止更新重启。

## 运行与验证

```powershell
npm install
npm run dev:desktop
```

构建并启动生产模式客户端：

```powershell
npm run desktop
```

生成并校验 Windows x64 安装包：

```powershell
npm run package:win
```

输出位于 `release/publish/`：

- `RemoteTerminal-Setup-<版本>-x64.exe`：NSIS 安装器；
- 同名 `.blockmap` 与 `latest.yml`：差分更新和更新完整性元数据；
- `SHA256SUMS.txt`：安装器 SHA-256 校验值；
- `win-unpacked/RemoteTerminal.exe`：仅用于打包后的 smoke test。

正式发布时必须把安装器、`.blockmap` 与 `latest.yml` 作为同一 GitHub Release 的资产上传。客户端不会内置 GitHub Token，也不接受运行时修改更新源。

主要验证：

```powershell
npm test
node scripts/qa-playwright.mjs
node scripts/qa-electron.mjs --production
node scripts/qa-native-ssh.mjs
```

`qa-native-ssh` 使用隔离的本地 `ssh2` 服务验证真实握手、指纹确认、密码终端、命令模板插入、Windows 加密凭据往返和剪贴板桥接，不连接外部服务器。

## 当前边界

- 目前只支持密码认证；私钥、SSH Agent、跳板机和端口转发尚未实现。
- 只上传普通文件，不支持目录递归、同步、远程编辑和静默覆盖。
- 命令提示当前来自本地静态模板，不是远端命令索引、会话历史推荐或 AI 生成；插入前需确认当前位于 Shell 提示符。
- 已保存密码由 Windows 当前用户加密保护，可防止其他 Windows 用户直接读取，但不能抵御已获得同一用户权限的恶意程序；保存密码并非默认选项。
- 外观设置暂不持久化。
- 当前 NSIS 安装器尚未进行 Windows 代码签名，首次下载或安装可能出现 SmartScreen 提示；这不影响更新元数据的 SHA-512 校验，但正式公开分发仍应配置稳定的代码签名证书。
- 已通过本地真实 SSH 协议测试，但尚未完成 Ubuntu/Rocky 真机兼容矩阵及大文件校验。
- `0.1.0` 首发只能验证更新源与客户端能力；完整的自动升级闭环需要发布更高版本后执行旧版 → 新版双版本验收。
