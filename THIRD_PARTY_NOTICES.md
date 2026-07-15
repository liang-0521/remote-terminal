# Third-party notices

Remote Terminal 0.4.1 includes the open-source components listed below. Versions and license identifiers are taken from the installed npm package metadata and Cargo registry manifests used by this release. “Copyright / attribution” reproduces the wording found in bundled license files where available; an author-only entry is identified as metadata and does not assert copyright ownership.

The runtime tables cover the project's core direct production dependencies; the separate build-time table records direct release tooling. Transitive dependencies remain subject to their own licenses.

## WebView user interface

| Project | Included packages | Copyright / attribution | License | Upstream |
| --- | --- | --- | --- | --- |
| Tauri JavaScript API and plugins | `@tauri-apps/api` 2.11.1; `@tauri-apps/plugin-clipboard-manager` 2.3.2; `@tauri-apps/plugin-dialog` 2.7.1; `@tauri-apps/plugin-updater` 2.10.1 | Copyright (c) 2017-present Tauri Apps Contributors; plugin SPDX metadata also identifies 2019-2022 The Tauri Programme in the Commons Conservancy | Apache-2.0 OR MIT | [Tauri](https://github.com/tauri-apps/tauri), [Tauri plugins](https://github.com/tauri-apps/plugins-workspace) |
| React | `react` 19.2.0; `react-dom` 19.2.0 | Copyright (c) Meta Platforms, Inc. and affiliates | MIT | [facebook/react](https://github.com/facebook/react) |
| xterm.js | `@xterm/xterm` 6.0.0; `@xterm/addon-fit` 0.11.0 | Copyright (c) 2017-2019 The xterm.js authors; 2014-2016 SourceLair Private Company; 2012-2013 Christopher Jeffrey; addon copyright (c) 2019 The xterm.js authors | MIT | [xtermjs/xterm.js](https://github.com/xtermjs/xterm.js) |
| Recharts | `recharts` 3.9.2 | Copyright (c) 2015-present recharts | MIT | [recharts/recharts](https://github.com/recharts/recharts) |
| Phosphor Icons | `@phosphor-icons/react` 2.1.10 | Copyright (c) 2020 Phosphor Icons | MIT | [phosphor-icons/react](https://github.com/phosphor-icons/react) |

## Windows native core

| Project | Included crates | Copyright / attribution | License | Upstream |
| --- | --- | --- | --- | --- |
| Tauri runtime and plugins | `tauri` 2.11.5; `tauri-plugin-clipboard-manager` 2.3.2; `tauri-plugin-dialog` 2.7.1; `tauri-plugin-single-instance` 2.4.3; `tauri-plugin-updater` 2.10.1 | Copyright (c) 2017-present Tauri Apps Contributors; plugin SPDX metadata also identifies 2019-2022 The Tauri Programme in the Commons Conservancy | Apache-2.0 OR MIT | [Tauri](https://github.com/tauri-apps/tauri), [Tauri plugins](https://github.com/tauri-apps/plugins-workspace) |
| atomic-write-file | `atomic-write-file` 0.3.0 | Andrea Corbellini (Cargo author metadata; the packaged license does not state a copyright year) | BSD-3-Clause | [andreacorbellini/rust-atomic-write-file](https://github.com/andreacorbellini/rust-atomic-write-file) |
| Bytes | `bytes` 1.12.1 | Copyright (c) 2018 Carl Lerche | MIT | [tokio-rs/bytes](https://github.com/tokio-rs/bytes) |
| Chrono | `chrono` 0.4.45 | Copyright (c) 2014-2026 Kang Seonghoon and contributors | MIT OR Apache-2.0 | [chronotope/chrono](https://github.com/chronotope/chrono) |
| drag-rs | `drag` 2.1.1 | Copyright (c) 2023 - Present CrabNebula Ltd. | Apache-2.0 OR MIT | [crabnebula-dev/drag-rs](https://github.com/crabnebula-dev/drag-rs) |
| Keyring | `keyring-core` 1.0.0; `windows-native-keyring-store` 1.1.0 | Copyright (c) 2016 keyring Developers | MIT OR Apache-2.0 | [keyring-core](https://github.com/open-source-cooperative/keyring-core), [Windows native store](https://github.com/open-source-cooperative/windows-native-keyring-store) |
| Russh | `russh` 0.62.2 | Pierre-Étienne Meunier (Cargo author metadata) | Apache-2.0 | [warp-tech/russh](https://github.com/warp-tech/russh) |
| Russh SFTP | `russh-sftp` 2.3.0 | The packaged license does not state specific copyright attribution | Apache-2.0 | [AspectUnk/russh-sftp](https://github.com/AspectUnk/russh-sftp) |
| Serde | `serde` 1.0.228; `serde_json` 1.0.150 | Erick Tryzelaar and David Tolnay (Cargo author metadata) | MIT OR Apache-2.0 | [serde-rs/serde](https://github.com/serde-rs/serde), [serde-rs/json](https://github.com/serde-rs/json) |
| Tokio | `tokio` 1.52.3 | Copyright (c) Tokio Contributors | MIT | [tokio-rs/tokio](https://github.com/tokio-rs/tokio) |
| UUID | `uuid` 1.23.5 | Copyright (c) 2014 The Rust Project Developers; copyright (c) 2018 Ashley Mannix, Christopher Armstrong, Dylan DPC and Hunar Roop Kahlon | Apache-2.0 OR MIT | [uuid-rs/uuid](https://github.com/uuid-rs/uuid) |

## Build-time components

These tools are direct build dependencies and are not application runtime services.

| Project | Included packages | Copyright / attribution | License | Upstream |
| --- | --- | --- | --- | --- |
| Tauri build tools | `@tauri-apps/cli` 2.11.4; `tauri-build` 2.6.3 | Copyright (c) 2017-present Tauri Apps Contributors | Apache-2.0 OR MIT | [tauri-apps/tauri](https://github.com/tauri-apps/tauri) |
| Vite | `vite` 6.4.2 | Copyright (c) 2019-present VoidZero Inc. and Vite contributors | MIT | [vitejs/vite](https://github.com/vitejs/vite) |
| Vite React plugin | `@vitejs/plugin-react` 5.0.4 | Copyright (c) 2019-present Yuxi (Evan) You and Vite contributors | MIT | [vitejs/vite-plugin-react](https://github.com/vitejs/vite-plugin-react) |

## Phosphor Icons license

The application interface and Windows application icon use icons from Phosphor Icons.

MIT License

Copyright (c) 2020 Phosphor Icons

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
