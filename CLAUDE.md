# CLAUDE.md — manage_health プロジェクト規約

このファイルはClaude Codeが参照するプロジェクト固有の指示です。

## プロジェクト概要

Apple Health + あすけんの健康データをNotion DBに自動記録するパイプライン。

- **あすけんスクレイピング**: `src/scrape-asken.ts` (Playwright, TypeScript)
- **実行**: Claude Code Scheduled Task (毎時 `5 * * * *`)
- **Apple Health → Notion**: iOS Shortcut で直接POST

## Notion DB

| DB名 | Data Source ID | 用途 |
|---|---|---|
| 健康ログ | `69b6d762-8fc3-4d84-8292-32d8f8605998` | 1日1レコード |
| 食事サマリ | `8cb932fa-4f23-42de-aadb-190fee05f5dd` | 食事単位 (朝/昼/夕/間食の栄養素) |
| 食事記録 | `8cc7bf9d-ee58-46e2-a732-9dab077f6b70` | 食品単位 (name, quantity, calories) |
| HRV記録 | `3e4577a6-2264-474a-93af-a29a6315790a` | HRVサンプル単位 |

3層構造: 健康ログ(日) ← 食事サマリ(食事) ← 食事記録(食品)

## コマンド

```bash
# 依存関係インストール
npm install

# スクレイパー実行（headless）
npm run scrape

# 初回ログイン・デバッグ（headful）
npm run scrape:debug
```

## 重要ルール

1. **append-only**: Notionの食事サマリ・食事記録・HRV記録は追記のみ。既存レコードを変更しない
2. **ハッシュ重複検出**:
   - 食事記録（食品）: `SHA1(division|name|quantity)[0:8]`
   - 食事サマリ（食事）: `SHA1(division|calories|protein|fat|carbs|fiber)[0:8]`
3. **セッション管理**: `data/storageState.json` はgitignored。失効時は `npm run scrape:debug` で再ログイン
4. **JST**: 日付・時刻はすべてJST (UTC+9) を使用
5. **データソース**:
   - 食品単位: `/wsp/comment/YYYY-MM-DD`（name, quantity, caloriesのみ）
   - 食事単位の栄養素: `/wsp/advice/YYYY-MM-DD/{3,4,5}`（朝/昼/夕のみ、間食はcaloriesのみ）

## ファイル構成

```
src/
  scrape-asken.ts   # Playwright メインスクレイパー
  auth.ts           # storageState管理
  types.ts          # TypeScript型定義
data/
  storageState.json # セッションキャッシュ（gitignored）
scheduled-task/
  hourly-asken.md   # Scheduled Taskプロンプト
ios-shortcut/
  health-data-sync.md # iOS Shortcutセットアップ手順
```

## あすけんDOMが変わった場合

`src/scrape-asken.ts` の `sectionItems` 評価部分のセレクタを修正する。
変更後は `npm run scrape:debug` でブラウザを開いて動作確認すること。
