# dsh-pipeline — マルチ AI パイプライン用プラグイン + 自前のコントロールパネル
[中文](README.md) | [English (US)](README.en-US.md) | **日本語** | [Русский](README.ru.md)

`dsh-pipeline` は DSH のマルチ AI 協調パイプライン用プラグインです。メイン会話は作業を振り分けるだけで
自らは作業せず、作成 / テスト / レビューの三権を分離しています。権限外の呼び出し、手順の飛ばし、OK なしでの
タスク完了は、ツールが実行される前にコードで阻止されます。プラグインは**自前のコントロールパネル**を
同梱します —— クライアントのエントリ `lib/client.js` が、パネルを最初に描画するときに 14 個の
`lib/client.panel-*.js` chunk を必要に応じて取得し、セッション見出しの右側にパイプラインの状態・席位・
セッションプレビューを表示します。本リポジトリ = プラグインのソースコード + 開発者向けドキュメント +
納品レポートとアーキテクチャ図（いずれも `docs/`）+ 独立したローカル読み取り専用ページ（`dashboard/`）。

---

## リポジトリ構成

```
.
├── README.md / README.en-US.md / README.ja.md / README.ru.md   ← 4 言語で同期したリポジトリ説明
├── .gitattributes / .gitignore
├── MANIFEST.sha256            ← 自身を除く全ファイルの sha256（基準は docs/manifest.md）
├── plugin/
│   └── active/                ← プラグインのソースコード（唯一のコピー）。インストール時に profile へ複製
│       ├── index.js           ← ホスト側エントリ：apply / ツール / ガード / HTTP ルート / クライアント登録
│       ├── lib/               ← 実装：ドメインごとにサブディレクトリへ分割（panel/ とクライアント chunk を含む）
│       ├── presets/           ← 16 個のロールプリセット（src/ がソース、generated/ が生成物）
│       ├── tests/             ← 自測：110 スイート、1 ファイル 1 スイート
│       ├── tools/             ← リポジトリ用ツール。install-items.json が複製範囲の唯一の出所
│       ├── design/            ← 公開設計記録（agent-teams / memory / panel）
│       ├── locale/ skills/
│       ├── install.ps1 / rollback.ps1
│       ├── package.json / cordis.patch.yml
│       └── README.md / ARCHITECTURE.md / WIRING.md / CONVENTIONS.md
├── docs/                      ← 開発者向けドキュメント + 納品レポートとアーキテクチャ図
│   ├── README.md / install.md / …（1 ファイル 1 テーマ）
│   └── 产出交付文档-v3-20261014/   ← 今回のレポート + アーキテクチャ図 v3（v2 は履歴として保持）
└── dashboard/                 ← 独立したローカル読み取り専用ページ（dashboard/README.md を参照）
```

---

## 1. デプロイ：clone → インストール

```powershell
git clone <リポジトリ URL> dsh-pipeline
cd dsh-pipeline
powershell -NoProfile -ExecutionPolicy Bypass -File .\plugin\active\install.ps1 -DryRun   # まず予行
powershell -NoProfile -ExecutionPolicy Bypass -File .\plugin\active\install.ps1            # 本番インストール
```

インストーラーが行うのは複製と登録だけです。実行時ファイルを
`<DSH ユーザーディレクトリ>\profiles\<profile>\node_modules\dsh-pipeline\` へ複製し、その profile の
`package.json` / `cordis.patch.yml` にプラグイン登録を追記し（変更前に両方バックアップ）、同梱の
stop-ladder Skill を `<DSH ユーザーディレクトリ>\skills\stop-ladder\` へ配置します。

| 段階 | 得られるもの |
|---|---|
| **clone 後** | リポジトリ全体：`plugin/active/`（ソース + `tests/` + `presets/` + `design/`）、`docs/`、`dashboard/`、`MANIFEST.sha256`。 |
| **install が profile に入れるもの** | **実行時ファイル**のみ：`index.js`、`lib/`、`locale/`、`skills/`、`presets/`、`icon.svg`、`package.json`、`cordis.patch.yml`、`README.md`、`ARCHITECTURE.md`、2 つの `.ps1`、そして `tests/`（`pipeline_selftest` が読むため）。 |
| **既定では入れないもの** | リポジトリ直下の `docs/` と `dashboard/`（インストーラーは `plugin/active/` からしか複製しません）、およびプラグインディレクトリ内の `design/`、`examples/`、`REPORT.md`、`tools/`。これらは clone でダウンロードされるだけで、profile には入りません。 |
| **`-WithDocs` のときだけ入るもの** | `examples/`、`REPORT.md`、`tools/`（いずれも `plugin/active/` 内）。 |

複製範囲の出所は 1 か所だけです：`plugin/active/tools/install-items.json`。`install.ps1` と
`tools/sync*.mjs` が同じ 1 枚を読むので、これを変えると 3 か所が同時に変わります。

| よく使うパラメーター | 説明 |
|---|---|
| `-DryRun` | これから何をするかだけを表示し、ファイルは変更しません。 |
| `-Profile <名前>` | どの profile に入れるか。既定は `desktop`。 |
| `-WithDocs` | `examples/`、`REPORT.md`、`tools/` も入れます。 |
| `-NoSpawnRoles` | トークンだけを発行し、ロールセッションは作りません（ゼロトークンの試走モード）。 |

全パラメーター（`-ProjectRoot` / `-Transport` / `-GuardMainReadsCode` / `-MaxReworkPerLeg` /
`-L0OrchestratorSeparate` …）、スクリプトが変更する内容、ロールバック（`rollback.ps1`）は
[`docs/install.md`](docs/install.md) を参照してください。インストール後は **DSH を再起動**する
（またはプラグインを再読み込みする）まで、実行中のプロセスには反映されません。

---

## 2. プラグインのソースコード：`plugin/active/`

### モジュール構成

エントリーポイントは `index.js` で、実装は `lib/` にあります。もともと千行を超えていた 5 つの大きな
ファイルは主題ごとにサブディレクトリへ分割し、元のファイルはファサードとして残しています（外部へ公開する
名前は変わらないため、呼び出し側は import を変更する必要がありません）：

| ファサード | サブディレクトリ | 内容 |
|---|---|---|
| `lib/store.js` | `lib/store/` | タスクの保存：永続化の読み書き、主管ハブの判定基準、状態遷移の前提条件、交接物の提出、人工介入… |
| `lib/tools.js` | `lib/tools/` | `pipeline_*` ツールの定義（ツールごとにグループ化） |
| `lib/guard.js` | `lib/guard/` | ガード：ロールの読み書き分類、席位と権限範囲、shell の判定基準、スクリプトの展開、本体判定 |
| `lib/handoff.js` | `lib/handoff/` | 交接物：フィールド表、検証、内容スキャン、記録 |
| `lib/wakeup.js` | `lib/wakeup/` | ウェイクアップ：ウェイクアップキー、台帳の同一性、配信、ウェイクアップ機構 |

機能ごとに分割したその他のドメイン：

| ディレクトリ | 内容 |
|---|---|
| `lib/panel/` | 自前パネル：`snapshot.js`（読み取り専用スナップショット）/ `seats.js`（席位の三層マージ）/ `task-fields.js`（フィールドとキー順の契約）/ `actions.js`（8 つの書き込みアクション）/ `archive.js`（`_trash` アーカイブビュー）/ `pins.js`（`_panel-pins.json` のピン留め） |
| `lib/model/` | ドメインオブジェクト：`task` / `baseline` / `artifact` / `close-report` / `human-request` / `handoff-*`（構造・既定値・フィールド一覧） |
| `lib/errors/` | エラーコード（`codes.js`）と拒否 / ヒント文言（`text.js`）の唯一の出所 |
| `lib/transport/` | チャネルのインターフェースと実装：`session` / `team` / `subagent` / `manual` / `simulated`。`createTransport()` が唯一の選択点 |
| `lib/team/` | 公式 Agent Teams のアダプター：命名、チャネル検査、人格の注入、四スロットの固定、配信、タスクボードのミラーリング |
| `lib/states/` `lib/tiers/` `lib/guard/` など | 状態機械・档位ルール・ゲート…はいずれも「1 ファイル 1 変更理由」で分割（`CONVENTIONS.md` §4） |

`docs/` 内のレポートに書かれている `lib/store.js:2471` のような行番号は、分割前の単一ファイルを
指しています。現在の位置は、現在のソースツリーの `lib/` 配下から該当するコードを探してください。

### クライアント：エントリ 1 + chunk 14

ブラウザ側は 1 つの大きなファイルではありません。エントリは 400 行（ちょうど上限）で、パネルの実装は
14 個の chunk に分かれています。

| ファイル | 行数 | 責務 |
|---|---|---|
| `lib/client.js` | 400（上限 400） | エントリ：モジュール登録、「マルチ AI 協調」スイッチ（order 100）、パネルの lazy wrapper（order 110。初回描画時にだけ chunk を取りに行く） |
| `lib/client.panel-*.js` ×14 | 各 ≤ 400 | パネル実装：`shell` / `view` / `atoms` / `data` / `seats` / `menu` / `batch` / `batch-bar` / `card-actions` / `actions` / `preview` / `preview-data` / `preview-control` / `preview-bubble` |

読み込み方は 3 段階です（chunk プロトコルはホストパッケージ
`@deepseek-ai/dsh-client-modules` がネイティブに提供します）：

1. **エントリ**：ホストは `/plugins/dsh-pipeline/client.js?rev=<エントリの rev>` を**クラシックスクリプト**として
   読み込みます（`import` / `export` / トップレベル `await` なし）。エントリ自身が
   `window.__ModuleLoader__.load({ id, factory })` で登録します。
2. **必要になってから chunk**：パネルを**初めて描画するとき**、エントリは
   `Promise.all(require.async('./client.panel-*.js'))` で 14 個の chunk を並行取得し、`shell` に
   渡して依存順に `create(deps)` で組み立てます —— パネルを開かなければダウンロードしません。
3. **ホストの配信**：chunk は `/plugins/dsh-pipeline/<chunk>?rev=<エントリの rev>` から配信されます。
   ホストは要求時にファイルを非同期で読み、**immutable としてキャッシュ**します（`rev` が変わった
   ときだけ再取得）。chunk はエントリと**同じディレクトリ**に置く必要があり、同じくクラシック
   スクリプトで、`window.__ModuleLoader__.load({ id, chunk, factory })` で登録します。chunk 同士は
   **同期 `require` できません**。組み立てはエントリだけで行います。

プロトコルが「エントリ + 同階層のファイル」なので、手書きの JS をそのまま置けます：
**tsdown も `package.json` の変更も不要**です。新しいクライアントロジックは必ず新しい chunk として
起こします（エントリは既に 400 行の上限に達しています）。理由と境界は
[`plugin/active/CONVENTIONS.md`](plugin/active/CONVENTIONS.md) §4 にあります。

### テスト

```powershell
cd plugin/active
node tests\run-all.mjs            # フルスイート。結果は tests\last-run.txt へ
node tests\<スイート>.mjs          # 1 スイートだけ実行
```

- フルスイートは現在 **3668/3668** が通過しています（**110 スイート**）。パネル関連は
  `panel-snapshot-check.mjs`（スナップショット契約）、`panel-actions-check.mjs`（書き込み
  アクション / アーカイブ / ピン留め）、`client-check.mjs`（エントリと 14 chunk の読み込み契約・
  描画・クリック、30 項目）です。
- 一部のスイートは**ホストのインストール**（`DSH_APP_ASAR` が
  `<DSH インストール>\resources\app.asar` を指す）を必要とします。プリセットとホスト schema の判定は
  そこからホストパッケージを読むためです。判定できない場合は「スキップ、通過率には計上しない」と
  明示されます。本機の口径：`DSH_APP_ASAR` を設定すると 3668/3668、設定しないとプリセット検証 3 件が
  赤になります（環境面でありコード面ではありません）。
- `tests/seat-liveness-wake-check.mjs` はフルスイートに登録されておらず、内容も現在の失聯の判定基準より
  古くなっているため、単独で実行すると失敗します。

---

## 3. コントロールパネル

### プラグイン内パネル（セッション見出しの右側）

`conversation.session.header.utilities`（list スロット）に、「マルチ AI 協調」スイッチと並べて
表示されます：

- **档位バッジ**：各タスクカードの左端に `L0`–`L5` の档位バッジとチーム人数（`N 個の AI`）が出るので、
  その単がどれくらい重いかが一目で分かります。
- **⋯ メニュー**：状態に応じて「中止 / 復帰 / アーカイブ / 削除」を並べます。削除は 2 回クリックでの
  確認が必要です。
- **ピン留め**：📌 ピン留め / 解除。ピン留めした単が最上位、残りは `updated_at` の降順です。
- **一括操作**：ヘッダーの「一括」→ 丸チェックで複数選択 → 下部の一括バーに「選択をアーカイブ /
  選択を削除」。直列に実行し、進捗を表示します。
- **アーカイブビュー**：ヘッダーの「アーカイブ N」でアーカイブ済みの単を一覧し、行内で「復帰」または
  「完全削除」（後者は 2 回クリックでの確認）ができます。「← タスクへ戻る」で戻ります。
- **ホバーでのセッションプレビュー**：席位 chip にマウスを止めると、パネルの左側に約 520×520 の
  プレビュー窓（最大 12 行、スクロール可）が出ます。表示するのは**実際のユーザー / AI の会話**だけで
  （注入されたシステムコンテキストとツール行は除外）、AI の本文がまだ無いときは「考えています…」と
  表示します。**任意の吹き出しをクリックするとそのセッションが開きます**（`openSession`）。

読み取りと書き込みは別の経路です：

| 用途 | ルート | 基準 |
|---|---|---|
| 読み取り | `GET /.dsh-pipeline/panel` | 読み取り専用スナップショット。5 秒ごとにポーリングし、ページが非表示の間はスキップ。`task.json` の構造化フィールド（id / 状態 / 要件の要約 / 席位 / 人手待ち件数 / タスクボード番号 / 档位 / ピン留め / `allowed_actions`）だけを読み、交接物の本文・パッチ・コードは**含めません** |
| 読み取り（アーカイブ） | `GET /.dsh-pipeline/panel?view=archived` | `<プロジェクトルート>/.pipeline/_trash/` 配下のアーカイブ済みの単を読み取り専用で一覧 |
| 書き込み | `POST /.dsh-pipeline/panel/action` | 8 アクション：`cancel` / `restore` / `archive` / `delete` / `pin` / `unpin` / `unarchive` / `delete_archived`。スイッチが切のときは一律拒否。`delete` / `delete_archived` は `confirm: true` が必要。同一オリジンの JSON のみ受け付け |

保存先（いずれもワークスペースの `.pipeline/` 配下で、profile に追随します）：ピン留めは
`_panel-pins.json`、アーカイブは `_trash/<タスク id>-<時刻>/`、完全削除の墓碑は `_purge-log.jsonl`。
設計のトレードオフとフィールド契約は
[`plugin/active/design/panel/01-面板设计.md`](plugin/active/design/panel/01-面板设计.md) にあります。

### 独立した読み取り専用ページ `dashboard/`

制御ロール（メイン会話 / 要件分析 / 主管 / アーカイブ）向けのローカル単一ページで、リクエストのたびに
`docs/` 配下の要件リスト、バグ票、変更ログを読み込みます。`127.0.0.1` のみを監視し、閲覧にはキーが
必要です。起動と停止は `dashboard\start.cmd` / `dashboard\stop.cmd`。詳細は
[`dashboard/README.md`](dashboard/README.md) を参照してください。

---

## 4. ドキュメント：`docs/`

開発者向けで、1 ファイルにつき 1 つのテーマを扱うドキュメントは [`docs/`](docs/README.md) にあります：

- [`docs/install.md`](docs/install.md) — インストール、パラメーター、スクリプトが変更する内容、ロールバック
- [`docs/directory-settings.md`](docs/directory-settings.md) — インストールディレクトリ / 作業ディレクトリの由来と、その上書き方法
- [`docs/encoding-conventions.md`](docs/encoding-conventions.md) — `.ps1` は UTF-8 BOM が必要、それ以外は不要、行末は LF
- [`docs/sandbox-temp-root.md`](docs/sandbox-temp-root.md) — `%TEMP%` が workspace 内に落ちると、制限付きシェルがすべて機能しなくなる
- [`docs/manifest.md`](docs/manifest.md) — `MANIFEST.sha256` の検証と生成の基準
- [`docs/agent-teams.md`](docs/agent-teams.md) — 公式 Agent Teams 統合（`transport: 'team'`）

納品期の成果物は `产出交付文档-v3-20261014/` にあります：今回のレポート
[`2026-10-18-面板与客户端分块.md`](docs/产出交付文档-v3-20261014/2026-10-18-面板与客户端分块.md)、
アーキテクチャ図 [`架构图-main-path-v3.html`](docs/产出交付文档-v3-20261014/架构图-main-path-v3.html)。
前回の
[`架构图-main-path-v2.html`](docs/产出交付文档-v3-20261014/架构图-main-path-v2.html) は履歴として保持し、
今後は変更しません。

**ドキュメントには本機のパスを一切書きません**：`%USERPROFILE%\.dsh\…`、`$HOME`、
`<path\to\thing>`、または相対パスを使います。パネルのアドレスは `127.0.0.1:<ポート>` と書き、
セッション ID などの元の値は残さず `session-…` と書きます。

---

## 5. 検証

`MANIFEST.sha256` は自身を除く、追跡対象のすべてのファイルの sha256 です。リポジトリのルートで
次を実行します：

```bash
sha256sum -c MANIFEST.sha256
```

ファイルを変更したら再生成が必要です（正確な基準と Windows での代替コマンドは
[`docs/manifest.md`](docs/manifest.md) を参照してください）。

---

## 6. ライセンスと出典

`plugin/` 配下のコードの作者、ライセンス、出典は `plugin/active/package.json` / `README.md` /
`ARCHITECTURE.md` に従います。`plugin/active/skills/stop-ladder/SKILL.md` はプラグインとともに
配布されるスキルファイルで、出典はファイル自体に記載されています。

---

## 7. ドキュメント索引

- [`docs/README.md`](docs/README.md) — 開発者向けドキュメントの目次
- [`docs/install.md`](docs/install.md) — インストール、パラメーター、ロールバック
- [`dashboard/README.md`](dashboard/README.md) — 独立したローカル読み取り専用ページ
- [`plugin/active/README.md`](plugin/active/README.md) — プラグインの完全な説明（設計目的、ロール、状態機械、ツール面、判定基準）
