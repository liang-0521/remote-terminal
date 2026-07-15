# Prototype Instructions

Run the local server yourself and open the preview in the browser available to this environment. Do not give the user server-start instructions when you can run it.

Before making substantial visual changes, use the Product Design plugin's `get-context` skill when the visual source is unclear or no longer matches the current goal. When the user gives durable prototype-specific design feedback, preferences, or decisions, record them in `AGENTS.md`.

When implementing from a selected generated mock, treat that image as the source of truth for layout, component anatomy, density, spacing, color, typography, visible content, and hierarchy.

## Test artifact hygiene

- Automated regression tests under `test/`, Rust `#[cfg(test)]` modules, and reusable fixtures are maintained quality-gate source, not disposable test leftovers.
- QA-only adapters, temporary local configs and servers, screenshots, comparison reports, logs, generated build output, and other task-specific test artifacts must stay ignored, must never be committed or pushed, and must be removed from the local workspace after the validation that created them finishes.
- Cleanup must enumerate and verify exact task-created paths. Never broaden cleanup to release/signing materials, user data, reusable source fixtures, or unrelated caches.
- Never terminate a preview or development instance that the user may be operating in order to unlock a build artifact. Run verification in an isolated Cargo target directory and, when needed, an isolated application identifier or instance; clean only those exact verification artifacts afterward.

## Selected visual direction

- Use the selected second generated concept from the local design-QA materials as the primary visual truth. Those source and comparison images intentionally stay outside version control.
- Preserve its IDE-style layout: narrow activity rail, remote-file explorer, terminal-first workspace, an uncluttered top bar, and a collapsible bottom panel.
- The activity rail is never hidden. The top-left menu toggles only between an icon-only compact rail and an expanded icon-plus-label rail.
- The production client uses the Tauri native adapter for SSH, SFTP, credential storage and monitoring. Demo data and mock runtime branches must not ship in Windows releases.
- Background metric and transfer updates must never steal focus from an active dialog field or terminal input.
- Keep only a compact CPU, memory, and Swap summary in the top bar, with no core count, disk, load, process, or network details there. Clicking the summary opens the bottom monitor tab.
- The monitor tab should adapt FinalShell's information architecture to the existing dark theme: system/load summary, CPU/memory/swap, top processes, network trend, and filesystem capacity.
- The bottom panel must support vertical resizing from its top edge. Keep the settings button fixed at the bottom of the full activity rail, independent of bottom-panel height.
- Transfer, issues, and monitor tabs share one user-controlled bottom-panel height; switching tabs must never change that height.
- Bottom-panel direction is spatial: use a down arrow to collapse the expanded panel and an up arrow to expand the collapsed panel.
- Settings must support accent color, terminal background/text colors, and an uploaded terminal background image. Prototype appearance data stays in the current page session only.
- Settings uses separate appearance, data/storage, and application pages. Color presets apply to accent, terminal background, and terminal text, including practical black and white choices.
- Durable application data defaults to the `data` directory beside the installed executable. The data/storage settings page may move it to another validated local Windows directory by copying only application-owned durable files, retaining the source for recovery, and requiring restart; credentials and WebView2 data never participate in this migration.
- Keep a session-only whole-interface theme selector directly above the settings button in the activity rail, with system, light, and dark modes. Terminal background/text customization remains independent of the interface theme.
- New SSH connections default to username `root` and password authentication. Password saving is opt-in and off by default; only save after successful SSH authentication through Windows Credential Manager, never in plaintext or inside the connection model.
- Menus, workspace tabs, remote file lists, transfer lists, and bottom tabs must be keyboard-operable with honest control semantics. Remove controls that have no implemented action instead of leaving decorative buttons that look interactive.
- Server management must expose a clearly visible add-server entry. Follow FinalShell's proven connection-manager pattern: save connections in a manager, open each server as an independent workspace tab, and preserve each workspace when switching instead of only swapping a selector label.
- Connection grouping is not part of the product model or list UI. A populated server picker exposes a visible open state; an empty picker goes directly to the add-server flow instead of opening an empty menu.
- Do not reserve a permanent upload drop-zone card. The remote file list itself is the SFTP drop target and should show a lightweight overlay only while files are dragged over it.
- Remote-file row actions live in a keyboard-operable context menu rather than permanent inline buttons. Open, download/drag-out, rename/move, delete, and refresh must invoke real native behavior; omit any item whose action is not implemented.
- Remote deletion is deliberately non-recursive. A file or symlink may be removed after confirmation, a directory may be removed only when empty, and a non-empty directory must fail explicitly. Rename/move must preserve the remote entry type and reject unsafe or conflicting destinations.
- Windows releases use the fixed `com.liang.remote-terminal` NSIS identity and public GitHub Releases metadata. Never embed a GitHub token or a configurable update feed in the client.
- Updates may check and download in the background, but must not steal focus or restart automatically. Block restart installation while any SFTP upload is queued, uploading, cancelling, or finalizing.
- Version 0.4.0 remains a Windows-only Tauri 2 client. React, xterm and the selected IDE-style visual direction may remain in the WebView2 UI, but SSH, SFTP, monitoring, updates, transfers and durable state must run in the Rust core so hiding the window never pauses background work.
- Closing the main window must support a persisted user choice between running in the system tray and exiting. The tray provides at least “显示主窗口” and “退出”. Only a real exit with active SSH sessions or transfers shows one unified warning containing both counts; hiding to the tray never warns or disconnects and preserves every workspace.
- Command assistance has two distinct surfaces: the explicit button opens a searchable command library with Chinese semantic and English command/intent search, while reliable non-empty terminal input such as `ll` opens a compact HexHub-style candidate list next to the active cursor line. Rank both surfaces from server commands, the current remote directory, locally persisted per-server command history and bilingual semantic keywords. Only local history is deletable; remote executable-command results are not history and cannot be deleted. An exact full command closes inline suggestions. Tab inserts without executing, Enter remains the explicit execution action, Escape closes suggestions, and no command content leaves the device.
- A monitor-data rendering failure must never unmount the full application. Filesystem usage uses the validated percentage returned by the native parser as its single truth source, including small mounts below 0.01 GiB, and release QA must open the real native monitor path.
- Windows installers must show a destination-directory page so users can choose another disk. Future release validation must compare the complete Electron and Tauri/WebView2 process trees on the same machine; the user explicitly accepted the measured v0.3.1 memory result as a one-time release exception, which must not weaken later performance gates.
- The project has no trusted Authenticode code-signing certificate. Do not run Authenticode certificate or timestamp preflight checks, do not require Authenticode configuration, and do not block packaging or publishing on Authenticode unless the user later provides a certificate and explicitly asks to re-enable it. Keep Tauri updater signatures and SHA-256 checks mandatory, and disclose the unsigned publisher state in release notes.
