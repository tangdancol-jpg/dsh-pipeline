# dsh-pipeline — Plugin source, delivery docs, and control panel
[中文](README.md) | **English (US)** | [日本語](README.ja.md) | [Русский](README.ru.md)

`dsh-pipeline` is the multi-AI collaboration pipeline plugin for DSH: the main conversation only dispatches work and does not do the work itself, and the writing / testing / review roles are kept strictly separate;
out-of-scope calls, skipped steps, and closing a task without an OK are blocked in code before the tool runs. This repository contains the plugin source, implementation reports and delivery docs for each round, as well as a local read-only control panel.

---

## Table of contents

```
.
├── README.md                  ← 本文件
├── .gitignore
├── .gitattributes             ← 行尾统一：文本一律 LF
├── MANIFEST.sha256            ← 逐文件 sha256（不含自身）
├── plugin/
│   └── active/                ← 插件源码（唯一一份）
├── dashboard/                 ← 本地只读控制面板（见 dashboard/README.md）
└── docs/                      ← 实现报告、交付文档、架构图
```

---

## 1. Plugin source: `plugin/active/`

`plugin/active/` is the only copy; it corresponds to the files under `profiles/desktop/node_modules/dsh-pipeline/` after installation.
(A pre-refactor monolithic legacy copy, `plugin/src/`, used to coexist; it was outdated and had no references, so it was deleted; it is still preserved in history.)

### Module layout

The entry point is `index.js`; the implementation lives in `lib/`. The five original files of over a thousand lines each have been split by topic into subdirectories,
while the original files remain as facades (exported names unchanged, so callers do not need to change imports):

| Facade | Subdirectory | Contents |
|---|---|---|
| `lib/store.js` | `lib/store/` | Task storage: persistence reads and writes, supervisor-hub criteria, state-transition preconditions, handoff submission, human intervention… |
| `lib/tools.js` | `lib/tools/` | `pipeline_*` tool definitions, grouped by tool |
| `lib/guard.js` | `lib/guard/` | Guard: role read/write classification, seats and authorized scope, shell criteria, script expansion, main decision |
| `lib/handoff.js` | `lib/handoff/` | Handoffs: field tables, validation, content scanning, records |
| `lib/wakeup.js` | `lib/wakeup/` | Wakeup: wakeup keys, ledger identity, delivery, waker |

Line numbers such as `lib/store.js:2471` in the reports under `docs/` refer to the single file before the split;
to find the current location, look up the corresponding code under `lib/` in the current source tree.

### Tests

```bash
cd plugin/active
node tests/run-all.mjs            # 全套；结果写到 tests/last-run.txt
node tests/<套件>.mjs             # 单跑一套
```

- The full suite currently passes **1588/1588** (39 suites).
- Another 3 suites require host packages (`@deepseek-ai/dsh-tools`, `@deepseek-ai/cordis`); when they are unavailable on this machine they are skipped and clearly marked, and are not counted in the pass rate.
- `tests/seat-liveness-wake-check.mjs` is not registered in the full suite, and its content is outdated relative to the current liveness criteria, so running it on its own will fail.

### Installation

`plugin/active/install.ps1` copies the runtime files into the DSH profile and registers the plugin; `rollback.ps1` rolls back.
After changing the code, restart DSH (or reload the plugin) for the change to take effect in the running process.

---

## 2. Control panel: `dashboard/`

A local read-only single-page panel for the control roles (main conversation / requirements analysis / supervisor / archivist); each request reads the requirement tickets, bug tickets, and change logs under
`docs/` on the fly. It only listens on `127.0.0.1`, and a key is required to view it.
Start/stop: `dashboard\start.cmd` / `dashboard\stop.cmd`; for details see [`dashboard/README.md`](dashboard/README.md).

---

## 3. Docs: `docs/`

Developer-facing documents, one topic per file, live in [`docs/`](docs/README.md):

- [`docs/install.md`](docs/install.md) — installation, parameters, what the scripts change, rollback
- [`docs/directory-settings.md`](docs/directory-settings.md) — where the install directory / working directory come from, and how to override them
- [`docs/encoding-conventions.md`](docs/encoding-conventions.md) — `.ps1` must be UTF-8 BOM, everything else must not be, line endings LF
- [`docs/sandbox-temp-root.md`](docs/sandbox-temp-root.md) — when `%TEMP%` falls inside the workspace, restricted shells all fail
- [`docs/manifest.md`](docs/manifest.md) — how `MANIFEST.sha256` is verified and generated

There are also artifacts left over from the delivery period: `产出交付文档-v3-20261014/` (including the architecture diagram `架构图-main-path-v2.html`).

**Documents never contain machine-local paths**: use `%USERPROFILE%\.dsh\…`, `$HOME`, `<path\to\thing>`, or relative paths;
the panel address is written as `127.0.0.1:18240`; raw values such as session ids are not retained and are written as `session-…`.

---

## 4. Verification

`MANIFEST.sha256` is the sha256 of every file except itself. Run this from the repository root:

```bash
sha256sum -c MANIFEST.sha256
```

After changing files, regenerate it (for the exact rules and the Windows alternative command, see [`docs/manifest.md`](docs/manifest.md)).

---

## 5. License and provenance

The authorship, license, and provenance of the code under `plugin/` are governed by `plugin/active/package.json` / `README.md` / `ARCHITECTURE.md`.
`plugin/active/skills/stop-ladder/SKILL.md` is a skill file distributed with the plugin; its provenance is described in the file itself.
