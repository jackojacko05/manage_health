# manage_health

Apple Health + あすけんの健康データをNotion DBに自動記録するパイプライン。

## セットアップ

```bash
npm install && npx playwright install chromium
cp .env.example .env  # 値を埋める
npm run scrape:debug   # 初回ログイン
npm run sync           # 動作確認
```

## コマンド

| コマンド | 内容 |
|---|---|
| `npm run scrape` | あすけんをheadlessスクレイプ（JSON出力） |
| `npm run scrape:debug` | headfulで手動ログイン・デバッグ |
| `npm run sync` | 今日の記録をNotionに同期 |
| `DATE=YYYY-MM-DD npm run sync:date` | 指定日を同期 |

## ルール・規約

詳細は `.claude/rules/` を参照:

- `.claude/rules/no-personal-info.md` — 個人情報・環境固有値の禁止
- `.claude/rules/coding-conventions.md` — コーディング規約・データ操作ルール
