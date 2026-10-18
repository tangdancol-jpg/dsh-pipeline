# dsh-pipeline — multi-AI pipeline plugin + built-in control panel
[中文](README.md) | **English (US)** | [日本語](README.ja.md) | [Русский](README.ru.md)

`dsh-pipeline` is the multi-AI collaboration pipeline plugin for DSH: the main conversation only
dispatches work and does not do the work itself, and the writing / testing / review roles are kept
strictly separate; out-of-scope calls, skipped steps, and closing a task without an OK are blocked
in code before the tool runs. The plugin ships its own **built-in control panel** — the client entry
`lib/client.js` (375 lines) fetches 18 `lib/client.panel-*.js` chunks on demand the first time the
panel is rendered (entry + chunks: 19 files, 4743 lines), and shows pipeline state, seats, and a
session preview in the conversation header; popovers are mounted with `ReactDOM.createPortal` onto
`document.body` and positioned with `position:fixed`. This repository = plugin source + developer
docs + delivery reports and diagrams (all under `docs/`) + a separate local read-only page
(`dashboard/`).

---

## Repository layout

```
.
├── README.md / README.en-US.md / README.ja.md / README.ru.md   ← the same repository notes in four languages
├── .gitattributes / .gitignore
├── LICENSE                    ← MIT
├── MANIFEST.sha256            ← sha256 of every file except itself; rules in docs/manifest.md
├── plugin/
│   └── active/                ← plugin source (the only copy); copied into the profile by the installer
│       ├── index.js           ← host-side entry: apply / tools / guard / HTTP routes / client registration
│       ├── lib/               ← implementation, split by domain (including panel/ and the 18 client chunks)
│       ├── presets/           ← 16 role presets (src/ is the source, generated/ is the output)
│       ├── tests/             ← self-tests: 125 suites, one file per suite
│       ├── tools/             ← repository tools; install-items.json is the single source of the copy scope
│       ├── design/            ← open design records (agent-teams / memory / panel)
│       ├── locale/ skills/
│       ├── install.ps1 / rollback.ps1
│       ├── package.json / cordis.patch.yml
│       └── README.md / ARCHITECTURE.md / WIRING.md / CONVENTIONS.md
├── docs/                      ← developer docs + delivery reports and diagrams
│   ├── README.md / install.md / … (one topic per file)
│   ├── release-checklist.md   ← pre-push checklist
│   └── 产出交付文档-v3-20261014/   ← this round's report + architecture diagram v3 (v2 kept as history)
└── dashboard/                 ← separate local read-only page (see dashboard/README.md)
```

---

## 1. Deployment: clone → install

```powershell
git clone https://github.com/tangdancol-jpg/dsh-pipeline.git dsh-pipeline
cd dsh-pipeline
powershell -NoProfile -ExecutionPolicy Bypass -File .\plugin\active\install.ps1 -DryRun   # dry run first
powershell -NoProfile -ExecutionPolicy Bypass -File .\plugin\active\install.ps1            # real install
```

The installer only copies and registers: it copies the runtime files into
`<DSH user directory>\profiles\<profile>\node_modules\dsh-pipeline\`, appends the plugin
registration to that profile's `package.json` / `cordis.patch.yml` (backing both up first), and
drops the bundled stop-ladder skill into `<DSH user directory>\skills\stop-ladder\`.

| Stage | What you get |
|---|---|
| **After clone** | The whole repository: `plugin/active/` (source + `tests/` + `presets/` + `design/`), `docs/`, `dashboard/`, `MANIFEST.sha256`. |
| **What install puts into the profile** | Only **runtime files**: `index.js`, `lib/`, `locale/`, `skills/`, `presets/`, `icon.svg`, `package.json`, `cordis.patch.yml`, `README.md`, `ARCHITECTURE.md`, the two `.ps1` files, and `tests/` (`pipeline_selftest` reads it). |
| **What is not installed by default** | `docs/` and `dashboard/` at the repository root (the installer only copies from `plugin/active/`), plus `design/`, `examples/`, `REPORT.md`, and `tools/` inside the plugin directory. They arrive with the clone; they just do not go into the profile. |
| **Only with `-WithDocs`** | `examples/`, `REPORT.md`, `tools/` (still inside `plugin/active/`). |

The copy scope has exactly one source: `plugin/active/tools/install-items.json` — both
`install.ps1` and `tools/sync*.mjs` read it, so editing it changes three places at once.

| Common parameter | Meaning |
|---|---|
| `-DryRun` | Print what would happen; change nothing. |
| `-Profile <name>` | Which profile to install into; default `desktop`. |
| `-WithDocs` | Also install `examples/`, `REPORT.md`, `tools/`. |
| `-NoSpawnRoles` | Issue tokens only, create no role sessions (zero-token dry run). |

For the full parameter set (`-ProjectRoot` / `-Transport` / `-GuardMainReadsCode` /
`-MaxReworkPerLeg` / `-L0OrchestratorSeparate` …), what the script changes, and how to roll back
(`rollback.ps1`), see [`docs/install.md`](docs/install.md). After installing, **restart DSH**
(or reload the plugin) before the running process uses the new code.

---

## 2. Plugin source: `plugin/active/`

### Module layout

The entry point is `index.js`; the implementation lives in `lib/`. The five original files of over
a thousand lines each have been split by topic into subdirectories, while the original files remain
as facades (exported names unchanged, so callers do not need to change imports):

| Facade | Subdirectory | Contents |
|---|---|---|
| `lib/store.js` | `lib/store/` | Task storage: persistence reads and writes, supervisor-hub criteria, state-transition preconditions, handoff submission, human intervention… |
| `lib/tools.js` | `lib/tools/` | `pipeline_*` tool definitions, grouped by tool |
| `lib/guard.js` | `lib/guard/` | Guard: role read/write classification, seats and authorized scope, shell criteria, script expansion, main decision |
| `lib/handoff.js` | `lib/handoff/` | Handoffs: field tables, validation, content scanning, records |
| `lib/wakeup.js` | `lib/wakeup/` | Wakeup: wakeup keys, ledger identity, delivery, waker |

Other domains split by function:

| Directory | Contents |
|---|---|
| `lib/panel/` | Built-in panel: `snapshot.js` (read-only snapshot) / `seats.js` (three-layer seat merge) / `task-fields.js` (field and key-order contract) / `actions.js` (8 write actions) / `archive.js` (`_trash` archive view) / `pins.js` (`_panel-pins.json` pins) |
| `lib/model/` | Domain objects: `task` / `baseline` / `artifact` / `close-report` / `human-request` / `handoff-*` (shape, defaults, field lists) |
| `lib/errors/` | The single source for error codes (`codes.js`) and refusal / hint texts (`text.js`) |
| `lib/transport/` | Transport interface and implementations: `session` / `team` / `subagent` / `manual` / `simulated`; `createTransport()` is the only selection point |
| `lib/team/` | Official Agent Teams adapter: naming, channel probing, persona injection, slot pinning, delivery, task-board mirroring |
| `lib/states/` `lib/tiers/` `lib/guard/` … | State machine, tier rules, gates… all split by "one file, one reason to change" (see `CONVENTIONS.md` §4) |

Line numbers such as `lib/store.js:2471` in the reports under `docs/` refer to the single file
before the split; to find the current location, look up the corresponding code under `lib/` in the
current source tree.

### Client: one 375-line entry + 18 chunks

The browser half is not one large file: the entry `lib/client.js` is **375 lines**, and the panel
implementation is split into **18** chunks — entry + chunks are **19 files, 4743 lines**. File size is
a signal, not a hard cap: over 400 lines prompts the four §4 self-check questions (single reason to
change / nameable in one phrase / reviewable boundary / parallel edits collide?), and whether to split
is a human/review call. The advisory report lives in `tests/file-size-check.mjs`.

| File | Lines | Responsibility |
|---|---|---|
| `lib/client.js` | 375 | Entry: module registration, the "multi-AI coordination" toggle (order 100), the panel lazy wrapper (order 110, fetches chunks only on first render) |
| `lib/client.panel-view.js` | 388 | Pure rendering: task cards / archive cards / lists / `[pipeline]` tags; no fetching, no state |
| `lib/client.panel-menu.js` | 335 | ⋯ menu: trigger, menu items, two-click confirmation text, in-card dropdown, pin button |
| `lib/client.panel-shell.js` | 320 | Component skeleton: shared scope `S`, calls each chunk's `create` / `setup` in dependency order, wires the skeleton together |
| `lib/client.panel-actions.js` | 297 | Action contract: the three routes, action table and texts, two-click confirmation criteria, fetch / submit write actions |
| `lib/client.panel-preview.js` | 296 | Preview material: size / timing / filter constants, `uiWorkspace` and `sessions` services, event window → preview rows |
| `lib/client.panel-atoms.js` | 294 | Content atoms: state / tier palettes, tier badge, team size, state badge, id, snippet, selectable card body |
| `lib/client.panel-preview-control.js` | 281 | Preview state machine: hover timing, 30 s cache, in-flight sequence guard, bubble click opens the real session, collapse on unmount / switch |
| `lib/client.panel-portal.js` | 249 | Popover container and exit: `createPortal` → `document.body`, fixed placement math, recompute on scroll / resize |
| `lib/client.panel-batch.js` | 240 | Batch state machine: enter / leave batch, whole-card selection, two-click delete, serial execution with progress, archive-view switch |
| `lib/client.panel-interact.js` | 223 | Interaction glue: open / pin and hover-close, card menu, action UI, batch and preview state slots, open a seat's session |
| `lib/client.panel-batch-bar.js` | 206 | Bottom batch bar: sticky full-width bar, buttons per view, progress and two-click confirmation |
| `lib/client.panel-preview-bubble.js` | 201 | Preview bubble: fixed-height rounded window, title row, up to 12 bubbles (user right / AI left, empty body "thinking…") |
| `lib/client.panel-seats.js` | 198 | Seat row: role display name, seat number, status dot, chip rendering and click / tooltip criteria |
| `lib/client.panel-outside.js` | 196 | Outside-click / ESC criteria: `ref.contains` + `target.closest` re-check, document capture listener, attach / detach effect |
| `lib/client.panel-preview-data.js` | 180 | Preview fetching and geometry: `retain` a session ref to read its event window, place the bubble against the panel's left edge |
| `lib/client.panel-poll.js` | 168 | Polling / fetching: 5 s polling of the snapshot and archive list, skip while the page is hidden, keep the last data on failure |
| `lib/client.panel-card-actions.js` | 167 | Card action execution: ⋯ menu open / close, two-click delete / purge confirmation, pin, which data to refresh after an action |
| `lib/client.panel-controls.js` | 129 | Clickable controls: header buttons, batch round checkbox, pin marker, all with no-drag and host event cut-off |

How it loads (three stages; the chunk protocol is native to the host package
`@deepseek-ai/dsh-client-modules`):

1. **Entry**: the host loads `/plugins/dsh-pipeline/client.js?rev=<entry rev>` as a **classic script**
   (no `import` / `export` / top-level `await`), and the entry itself registers via
   `window.__ModuleLoader__.load({ id, factory })`.
2. **Chunks on demand**: the first time the panel is rendered, the entry runs `Promise.all` over
   `require.async('./client.<name>.js')` to fetch all **18** chunks in parallel and hands them to
   `shell` to compose via `create(deps)` in dependency order — if the panel is never opened, nothing
   is downloaded.
3. **How the host serves them**: chunks come from `/plugins/dsh-pipeline/<chunk>?rev=<entry rev>`;
   the host reads the file asynchronously on demand and **caches it as immutable** (re-fetched only
   when `rev` changes). A chunk must sit **in the same directory as the entry** and is also a
   classic script, registered with `window.__ModuleLoader__.load({ id, chunk, factory })`. Chunks
   **cannot** synchronously `require` each other; composition happens only in the entry.

Because the protocol is "entry + sibling files", plain hand-written JS is enough: **no tsdown and
no `package.json` change**. New client logic always starts a new chunk (the entry is 375 lines — do
not stuff more into it); the rationale and boundaries are in
[`plugin/active/CONVENTIONS.md`](plugin/active/CONVENTIONS.md) §4.

**Why popovers hang off `document.body`**: the host's conversation header is a **window drag region**
with its own stacking order and hit area — while a popover lives inside that DOM, clicks can be
swallowed. So the ⋯ menu and the preview bubble render through
`ReactDOM.createPortal(children, document.body)` with `position:fixed`: the placement is computed
from the trigger's `getBoundingClientRect()` (`right = viewport width − rect.right`,
`top = rect.bottom + 6`, width `min(440, 92vw)`, height `min(560, 70vh)`, at least 8 px from every
edge), recomputed with a 100 ms throttle on scroll / resize; outside-click collapse is confirmed
through DOM attributes such as `target.closest('[data-pipeline-panel]')`, and when the criteria
cannot decide, the panel stays open (better to miss one close than to close a panel in use). When
`react-dom` is unavailable, it falls back to normal rendering instead of breaking the panel.

### Tests

```powershell
cd plugin/active
node tests\run-all.mjs            # full suite; writes tests\last-run.txt
node tests\<suite>.mjs            # run one suite
```

- The full suite currently passes **4074/4074** (**125 suites**). The panel-related five are
  `client-check.mjs` (loading contract, rendering and clicks for the entry and the 18 chunks,
  30 items), `panel-ui-check.mjs` (header "batch / archive" click regression, 14 items),
  `panel-portal-check.mjs` (popover portal and fixed placement, 3 items),
  `panel-snapshot-check.mjs` (snapshot contract, 74 items), and `panel-actions-check.mjs`
  (write actions / archive / pins, 99 items).
- A few suites need the **host installation**: `DSH_APP_ASAR` pointing at
  `<DSH install>\resources\app.asar`, because preset and host-schema criteria read host packages
  from there. When unavailable they are clearly marked "skipped, not counted in the pass rate". On
  this machine: with `DSH_APP_ASAR` set, 4074/4074; without it, 3 preset checks report red (an
  environment fact, not a code defect).
- `tests/seat-liveness-wake-check.mjs` is not registered in the full suite, and its content is
  outdated relative to the current liveness criteria, so running it on its own will fail.

The complete pre-push checklist is in [`docs/release-checklist.md`](docs/release-checklist.md).

---

## 3. Control panel

### Built-in panel (right side of the conversation header)

Mounted on `conversation.session.header.utilities` (a list slot), next to the "multi-AI
coordination" toggle:

- **Tier badge**: the leftmost item on each task card is the `L0`–`L5` tier badge plus the team
  size (`N AIs`), so you can see at a glance how heavy the task is.
- **⋯ menu**: per state it lists "stop / restore / archive / delete"; delete requires a second
  click to confirm.
- **Pins**: 📌 pin / unpin; pinned tasks sort first, the rest by `updated_at` descending.
- **Batch**: "Batch" in the header → tick multiple cards → the bottom batch bar offers "archive
  selected / delete selected", executed serially with progress.
- **Archive view**: "Archived N" in the header lists archived tasks, where each row offers "restore"
  or "delete permanently" (the latter needs a second click); "← back to tasks" returns.
- **Hover to open, click to pin**: hovering a seat chip opens it after 140 ms, moving away closes
  it after 800 ms; clicking the panel button pins it, and outside click or ESC closes it.
- **Large session preview**: hovering a seat chip pops a preview window of about 520×520 on the
  left of the panel (up to 12 rows, scrollable). It shows only **real user / AI conversation**
  (injected system context and tool rows are filtered); while an AI has no body text yet it shows
  "thinking…"; **clicking any bubble opens that session** (`openSession`).

Popovers (the ⋯ menu and the preview bubble) render through `ReactDOM.createPortal` onto
`document.body` with `position:fixed` — they do not live inside the host's conversation-header DOM,
which is a drag / stacking region where clicks would be swallowed.

Reads and writes are two separate paths:

| Purpose | Route | Contract |
|---|---|---|
| Read | `GET /.dsh-pipeline/panel` | Read-only snapshot, polled every 5 s and skipped while the page is hidden; reads only the structured fields of `task.json` (id / state / requirement snippet / seats / pending-human count / team-board number / tier / pinned / `allowed_actions`), **never** handoff bodies, patches, or code |
| Read (archive) | `GET /.dsh-pipeline/panel?view=archived` | Read-only list of archived tasks under `<project root>/.pipeline/_trash/` |
| Write | `POST /.dsh-pipeline/panel/action` | 8 actions: `cancel` / `restore` / `archive` / `delete` / `pin` / `unpin` / `unarchive` / `delete_archived`; all refused while the switch is off; `delete` / `delete_archived` require `confirm: true`; same-origin JSON only |

Where it lands (all under the workspace's `.pipeline/`, so it follows the profile): pins in
`_panel-pins.json`, archives in `_trash/<task id>-<stamp>/`, tombstones for permanent deletion in
`_purge-log.jsonl`. Design trade-offs and field contracts are in
[`plugin/active/design/panel/01-面板设计.md`](plugin/active/design/panel/01-面板设计.md).

### The separate read-only page `dashboard/`

A local single page for the control roles (main conversation / requirements analysis / supervisor /
archivist); every request reads the requirement list, bug tickets, and change log under `docs/` on
the fly. It listens only on `127.0.0.1` and needs a key; start and stop with `dashboard\start.cmd` /
`dashboard\stop.cmd`; details in [`dashboard/README.md`](dashboard/README.md).

---

## 4. DSH plugin declaration

`plugin/active/package.json` declares what the plugin is and which host layer it plugs into:

| Field | Value | Meaning |
|---|---|---|
| `name` | `dsh-pipeline` | Plugin package name, also the client module id and the `/plugins/<id>/` prefix |
| `version` | `0.1.0` | Package version |
| `dsh.manifestVersion` | `1` | Plugin manifest protocol version |
| `engines.dsh` | `>=0.2.1-rc.2` | Compatible DSH version range |
| `dsh.bundle.patch` | `cordis.patch.yml`, `presets/generated/pipeline-presets.patch.yml` | Cordis patch and role presets applied at load time |
| `dsh.client` | `platform: web`, `inject: ["@deepseek-ai/dsh-client-ui-workspace"]` | Host declaration for the client half; the entry is always the package-root `lib/client.js` (the host locates it by package name), and the entry fetches the 18 `client.panel-*.js` chunks from the same directory on demand |

- **Tools and guard provided**: the `pipeline_*` tool surface (open a task, requirements analysis,
  planning, dispatch, handoffs, review, close, query, self-test, switch…) and the corresponding
  monotonic guard — out-of-scope calls, skipped steps, and closing without an OK are refused before
  the tool runs; with the "multi-AI coordination" switch off the guard abstains and write actions
  are refused.
- **Installation**: `plugin/active/install.ps1` copies the runtime files into
  `<DSH user directory>\profiles\<profile>\node_modules\dsh-pipeline\` and appends the plugin
  registration to that profile's `package.json` / `cordis.patch.yml` (see section 1).
- **Compatibility**: it needs a DSH that **supports the package-local chunk protocol** — that
  protocol comes from `@deepseek-ai/dsh-client-modules` and is available from `0.2.1-rc.2`;
  `react-dom` is in that version's platform seed table, so the entry takes it from the host seed
  and does not bundle it. On older DSH the panel shows a readable one-line
  "multi-AI coordination team failed to load: <reason>", while the toggle and pipeline features keep
  working (no white screen).

---

## 5. Docs: `docs/`

Developer-facing documents, one topic per file, live in [`docs/`](docs/README.md):

- [`docs/install.md`](docs/install.md) — installation, parameters, what the scripts change, rollback
- [`docs/directory-settings.md`](docs/directory-settings.md) — where the install directory / working directory come from, and how to override them
- [`docs/encoding-conventions.md`](docs/encoding-conventions.md) — `.ps1` must be UTF-8 BOM, everything else must not be, line endings LF
- [`docs/sandbox-temp-root.md`](docs/sandbox-temp-root.md) — when `%TEMP%` falls inside the workspace, restricted shells all fail
- [`docs/manifest.md`](docs/manifest.md) — how `MANIFEST.sha256` is verified and generated
- [`docs/agent-teams.md`](docs/agent-teams.md) — official Agent Teams integration (`transport: 'team'`)
- [`docs/release-checklist.md`](docs/release-checklist.md) — pre-push checklist

Delivery-period artifacts live in `产出交付文档-v3-20261014/`: this round's report
[`2026-10-18-面板与客户端分块.md`](docs/产出交付文档-v3-20261014/2026-10-18-面板与客户端分块.md) and the
architecture diagram [`架构图-main-path-v3.html`](docs/产出交付文档-v3-20261014/架构图-main-path-v3.html);
the previous
[`架构图-main-path-v2.html`](docs/产出交付文档-v3-20261014/架构图-main-path-v2.html) is kept as history and
is no longer modified.

**Documents never contain machine-local paths**: use `%USERPROFILE%\.dsh\…`, `$HOME`,
`<path\to\thing>`, or relative paths; the panel address is written as `127.0.0.1:<port>`; raw values
such as session ids are not retained and are written as `session-…`.

---

## 6. Verification

`MANIFEST.sha256` is the sha256 of every tracked file except itself. Run this from the repository
root:

```bash
sha256sum -c MANIFEST.sha256
```

After changing files, regenerate it (for the exact rules and the Windows alternative command, see
[`docs/manifest.md`](docs/manifest.md)).

---

## 7. License and provenance

- **License**: MIT; the full text is in the root [`LICENSE`](LICENSE).
- **Repository**: <https://github.com/tangdancol-jpg/dsh-pipeline>.
- **Contributing**: use GitHub issues for defects / feature requests; PRs should keep the
  "one file, one topic" rule and the split discipline of `CONVENTIONS.md` §4, and include the
  result of `node tests\run-all.mjs` in the description.
- **Third-party dependencies**: **no runtime npm dependencies**; `@deepseek-ai/dsh-tools` is an
  optional peer (when unavailable, `defineTool` degrades to an identity function and the plugin
  still loads). `plugin/active/skills/stop-ladder/SKILL.md` ships with the plugin; its provenance is
  described in the file itself.

---

## 8. Documentation index

- [`docs/README.md`](docs/README.md) — developer documentation index
- [`docs/install.md`](docs/install.md) — installation, parameters, rollback
- [`docs/release-checklist.md`](docs/release-checklist.md) — pre-push checklist
- [`dashboard/README.md`](dashboard/README.md) — the separate local read-only page
- [`plugin/active/README.md`](plugin/active/README.md) — the full plugin manual (design goals, roles, state machine, tools, criteria)
