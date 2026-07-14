# Prototype Instructions

Run the local server yourself and open the preview in the browser available to this environment. Do not give the user server-start instructions when you can run it.

Before making substantial visual changes, use the Product Design plugin's `get-context` skill when the visual source is unclear or no longer matches the current goal. When the user gives durable prototype-specific design feedback, preferences, or decisions, record them in `AGENTS.md`.

When implementing from a selected generated mock, treat that image as the source of truth for layout, component anatomy, density, spacing, color, typography, visible content, and hierarchy.

## Selected visual direction

- Use the selected second generated concept from the local design-QA materials as the primary visual truth. Those source and comparison images intentionally stay outside version control.
- Preserve its IDE-style layout: narrow activity rail, remote-file explorer, terminal-first workspace, an uncluttered top bar, and a collapsible bottom panel.
- The production client uses the Tauri native adapter for SSH, SFTP, credential storage and monitoring. Demo data and mock runtime branches must not ship in Windows releases.
- Background metric and transfer updates must never steal focus from an active dialog field or terminal input.
- Keep only a compact CPU, memory, and Swap summary in the top bar, with no core count, disk, load, process, or network details there. Clicking the summary opens the bottom monitor tab.
- The monitor tab should adapt FinalShell's information architecture to the existing dark theme: system/load summary, CPU/memory/swap, top processes, network trend, and filesystem capacity.
- The bottom panel must support vertical resizing from its top edge. Keep the settings button fixed at the bottom of the full activity rail, independent of bottom-panel height.
- Bottom-panel direction is spatial: use a down arrow to collapse the expanded panel and an up arrow to expand the collapsed panel.
- Settings must support accent color, terminal background/text colors, and an uploaded terminal background image. Prototype appearance data stays in the current page session only.
- New SSH connections default to username `root` and password authentication. Password saving is opt-in and off by default; only save after successful SSH authentication through Windows Credential Manager, never in plaintext or inside the connection model.
- Menus, workspace tabs, remote file lists, transfer lists, and bottom tabs must be keyboard-operable with honest control semantics. Remove controls that have no implemented action instead of leaving decorative buttons that look interactive.
- Server management must expose a clearly visible add-server entry. Follow FinalShell's proven connection-manager pattern: save connections in a manager, open each server as an independent workspace tab, and preserve each workspace when switching instead of only swapping a selector label.
- Do not reserve a permanent upload drop-zone card. The remote file list itself is the SFTP drop target and should show a lightweight overlay only while files are dragged over it.
- Windows releases use the fixed `com.liang.remote-terminal` NSIS identity and public GitHub Releases metadata. Never embed a GitHub token or a configurable update feed in the client.
- Updates may check and download in the background, but must not steal focus or restart automatically. Block restart installation while any SFTP upload is queued, uploading, cancelling, or finalizing.
- Version 0.2.0 is a Windows-only Tauri 2 client. React, xterm and the selected IDE-style visual direction may remain in the WebView2 UI, but SSH, SFTP, monitoring, updates, transfers and durable state must run in the Rust core so hiding the window never pauses background work.
- Closing the main window must support a persisted user choice between running in the system tray and exiting. The tray provides at least “显示主窗口” and “退出”; explicit exit must warn before interrupting active transfers, while hiding to the tray preserves every SSH workspace.
- Command assistance must be real inline completion rather than a fixed template dialog. Rank suggestions from server commands, the current remote directory, per-server command history and Chinese semantic keywords; aliases such as `ll`, commands such as `ls`, and Chinese queries such as “查看文件” must resolve. Tab inserts without executing, Enter remains the explicit execution action, Escape closes suggestions, and no command content leaves the device.
- A monitor-data rendering failure must never unmount the full application. Filesystem usage uses the validated percentage returned by the native parser as its single truth source, including small mounts below 0.01 GiB, and release QA must open the real native monitor path.
- Windows installers must show a destination-directory page so users can choose another disk. Version 0.2.0 release validation must compare the complete Electron and Tauri/WebView2 process trees on the same machine; visible idle private memory must improve by at least 30% and a single connected SSH session by at least 25% before release.
