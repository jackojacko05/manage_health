# manage_health

Apple Health + あすけんの健康データを自動収集してNotion DBに記録するパイプライン。

## アーキテクチャ

```
[iPhone 22:00]                      [Mac ローカル 毎時:05]         [Notion]
Apple Health ─→ iOS Shortcut ──────────────────────────────→ 健康ログDB
(体重/歩数/HRV等)  (Notion API直接)                              ↑
                                                                │
                                    Claude Scheduled Task       │
                                    (5 * * * *)                 │
                                    Playwright scrape           │
                                    → あすけんDOM解析           │
                                    → 差分検出(SHA1ハッシュ)    │
                                    → 新規エントリ作成 ──────→ 食事記録DB
                                                           HRV記録DB
```

## Notion DB

| DB名 | 用途 |
|---|---|
| 健康ログ | 1日1レコード（体重・歩数・HRV集計・カロリー収支） |
| 食事記録 | 食品単位（あすけん毎時スクレイプ、append-only） |
| HRV記録 | Apple Watch HRVサンプル単位（iOS Shortcutが移植） |

## セットアップ

### 1. 依存インストール

```bash
npm install
npx playwright install chromium
```

### 2. 環境変数

```bash
cp .env.example .env
# ASKEN_EMAIL と ASKEN_PASSWORD を編集
```

### 3. 初回ログイン（ブラウザが開くので手動でログイン）

```bash
npm run scrape:debug
```

`data/storageState.json` が生成されたら完了。以降はheadlessで動作する。

### 4. 動作確認

```bash
npm run scrape  # JSON出力を確認
```

### 5. Claude Code Scheduled Task 登録

Claude Codeで以下を実行:

```
scheduled-task/hourly-asken.md の内容でScheduled Taskを作成して。
cron: 5 * * * *、モデル: claude-sonnet
```

### 6. iOS Shortcut設定

`ios-shortcut/health-data-sync.md` の手順に従ってShortcutを作成・設定する。

## セッション失効時

```bash
rm data/storageState.json
npm run scrape:debug  # 手動ログインして再生成
```

## PCスリープ設定

システム環境設定 → バッテリー → 「ディスプレイオフ時もシステムを稼働」をON
（ディスプレイはスリープしてよいが、システムスリープはNG）
