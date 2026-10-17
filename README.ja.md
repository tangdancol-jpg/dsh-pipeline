# dsh-pipeline — プラグインのソースコード、納品ドキュメント、コントロールパネル
[中文](README.md) | [English (US)](README.en-US.md) | **日本語** | [Русский](README.ru.md)

`dsh-pipeline` は DSH のマルチ AI 協調パイプライン用プラグインです。メイン会話は作業を振り分けるだけで自らは作業せず、作成 / テスト / レビューの三権を分離しています。
権限外の呼び出し、手順の飛ばし、OK なしでのタスク完了は、ツールが実行される前にコードで阻止されます。本リポジトリには、プラグインのソースコード、各ラウンドの実装レポートと納品ドキュメント、そしてローカルの読み取り専用コントロールパネルが含まれます。

---

## 目次

```
.
├── README.md                  ← 本文件
├── .gitignore
├── .gitattributes             ← 行尾统一：文本一律 LF
├── MANIFEST.sha256            ← 逐文件 sha256（不含自身）
├── plugin/
│   └── active/                ← 插件源码（唯一一份）
├── dashboard/                 ← 本地只读控制面板（见 dashboard/README.md）
└── docs/                      ← 開発者向けドキュメント（Agent Teams 統合を含む）+ 納品ドキュメント、アーキテクチャ図
```

---

## 1. プラグインのソースコード：`plugin/active/`

`plugin/active/` は唯一のコピーで、インストール後に `profiles/desktop/node_modules/dsh-pipeline/` 配下に置かれるファイルに対応します。
（以前はリファクタリング前のモノリシックな旧版 `plugin/src/` も併存していましたが、内容が古く参照も一切なかったため削除しました。履歴には残っています。）

### モジュール構成

エントリーポイントは `index.js` で、実装は `lib/` にあります。もともと千行を超えていた 5 つの大きなファイルは主題ごとにサブディレクトリへ分割し、
元のファイルはファサードとして残しています（外部へ公開する名前は変わらないため、呼び出し側は import を変更する必要がありません）：

| ファサード | サブディレクトリ | 内容 |
|---|---|---|
| `lib/store.js` | `lib/store/` | タスクの保存：永続化の読み書き、主管ハブの判定基準、状態遷移の前提条件、交接物の提出、人工介入… |
| `lib/tools.js` | `lib/tools/` | `pipeline_*` ツールの定義（ツールごとにグループ化） |
| `lib/guard.js` | `lib/guard/` | ガード：ロールの読み書き分類、席位と権限範囲、shell の判定基準、スクリプトの展開、本体判定 |
| `lib/handoff.js` | `lib/handoff/` | 交接物：フィールド表、検証、内容スキャン、記録 |
| `lib/wakeup.js` | `lib/wakeup/` | ウェイクアップ：ウェイクアップキー、台帳の同一性、配信、ウェイクアップ機構 |

`docs/` 内のレポートに書かれている `lib/store.js:2471` のような行番号は、分割前の単一ファイルを指しています。
現在の位置は、現在のソースツリーの `lib/` 配下から該当するコードを探してください。

その後追加された 2 つのサブシステムも機能ごとに分割されています（単一の大きなファイルではありません）：

| ディレクトリ | 内容 |
|---|---|
| `lib/transport/` | チャネルのインターフェースと実装：`session`（一級市民のセッション）/ `team`（公式 Agent Teams）/ `subagent` / `manual` / `simulated`。`createTransport()` が唯一の選択点です |
| `lib/team/` | 公式 Agent Teams のアダプター：命名、チャネル検査、ロール人格の注入、四スロットの固定、配信、タスクボードのミラーリング |

### テスト

```bash
cd plugin/active
node tests/run-all.mjs            # 全套；结果写到 tests/last-run.txt
node tests/<套件>.mjs             # 单跑一套
```

- フルスイートは現在 **3650/3650** が通過しています（108 スイート）。
- 一部のスイートは**ホストのインストール**（`DSH_APP_ASAR=<DSH インストール>/resources/app.asar`）またはホストパッケージ（`@deepseek-ai/dsh-tools`、`@deepseek-ai/cordis`）を必要とし、本機で見つからない場合はそのことが明示され、通過率には計上しません。本機の口径：`DSH_APP_ASAR` を設定すると 3650/3650、設定しないとプリセット検証 3 件が赤になります（環境面でありコード面ではありません）。
- `tests/seat-liveness-wake-check.mjs` はフルスイートに登録されておらず、内容も現在の失聯の判定基準より古くなっているため、単独で実行すると失敗します。

### インストール

`plugin/active/install.ps1` は実行時ファイルを DSH プロファイルへコピーしてプラグインを登録し、`rollback.ps1` はロールバックを行います。
コードを変更した後は、DSH を再起動する（またはプラグインを再読み込みする）まで、実行中のプロセスには反映されません。

---

## 2. コントロールパネル：`dashboard/`

制御ロール（メイン会話 / 要件分析 / 主管 / アーカイブ）向けのローカル読み取り専用シングルページパネルで、リクエストのたびに
`docs/` 配下の要件チケット、バグチケット、変更ログを読み込みます。`127.0.0.1` のみを監視し、閲覧にはキーが必要です。
起動と停止：`dashboard\start.cmd` / `dashboard\stop.cmd`。詳細は [`dashboard/README.md`](dashboard/README.md) を参照してください。

---

## 3. ドキュメント：`docs/`

開発者向けで、1 ファイルにつき 1 つのテーマを扱うドキュメントは [`docs/`](docs/README.md) にあります：

- [`docs/install.md`](docs/install.md) — インストール、パラメーター、スクリプトが変更する内容、ロールバック
- [`docs/directory-settings.md`](docs/directory-settings.md) — インストールディレクトリ / 作業ディレクトリの由来と、その上書き方法
- [`docs/encoding-conventions.md`](docs/encoding-conventions.md) — `.ps1` は UTF-8 BOM が必要、それ以外は不要、行末は LF
- [`docs/sandbox-temp-root.md`](docs/sandbox-temp-root.md) — `%TEMP%` が workspace 内に落ちると、制限付きシェルがすべて機能しなくなる
- [`docs/manifest.md`](docs/manifest.md) — `MANIFEST.sha256` の検証と生成の基準
- [`docs/agent-teams.md`](docs/agent-teams.md) — 公式 Agent Teams 統合（`transport: 'team'`）：能力の境界、設定、新しいガードのリスト、タスクボードのミラーリング、トラブルシューティング

このほか、納品期に残された成果物があります：`产出交付文档-v3-20261014/`（アーキテクチャ図 `架构图-main-path-v2.html` を含む）。

**ドキュメントには本機のパスを一切書きません**：`%USERPROFILE%\.dsh\…`、`$HOME`、`<path\to\thing>`、または相対パスを使います。
パネルのアドレスは `127.0.0.1:18240` と書き、セッション ID などの元の値は残さず `session-…` と書きます。

---

## 4. 検証

`MANIFEST.sha256` は自身を除くすべてのファイルの sha256 です。リポジトリのルートで次を実行します：

```bash
sha256sum -c MANIFEST.sha256
```

ファイルを変更したら再生成が必要です（正確な基準と Windows での代替コマンドは [`docs/manifest.md`](docs/manifest.md) を参照してください）。

---

## 5. ライセンスと出典

`plugin/` 配下のコードの作者、ライセンス、出典は `plugin/active/package.json` / `README.md` / `ARCHITECTURE.md` に従います。
`plugin/active/skills/stop-ladder/SKILL.md` はプラグインとともに配布されるスキルファイルで、出典はファイル自体に記載されています。
