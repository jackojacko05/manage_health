---
description: コーディング規約・データ操作ルール
paths:
  - "src/**"
---

# コーディング規約

## データ操作

- **append-only**: 食事記録・食事サマリ・HRV記録は追記のみ。既存レコードを変更・削除しない
- **ハッシュ重複検出**:
  - 食事記録（食品）: `SHA1(division|name|quantity)[0:8]`
  - 食事サマリ（食事）: `SHA1(division|calories|protein|fat|carbs|fiber)[0:8]`
- **冪等性**: 同じデータを何度syncしても結果が変わらないこと

## 日付・時刻

- ローカルシステム時刻を直接使う（`new Date().getFullYear()` 等）
- UTC + 9h のオフセット計算はしない（Mac = JST 前提）
- Notion API に渡す日時: `+09:00` オフセット付き ISO8601（`time_zone` フィールドは使わない）

## 終了コード（scrape-asken.ts）

| code | 意味 |
|---|---|
| 0 | 成功 |
| 2 | ログイン必要（セッション失効・認証情報不足）|
| 3 | DOMパース失敗（ページ構造変更）|
| 10 | 設定エラー（環境変数未設定）|
| 11 | Notion API エラー |
| 12 | 入力JSONパースエラー |

## Notion APIクライアント

- `src/notion-api.ts` の `queryDatabase` / `createPage` / `P.*` を使う
- Notion MCP（LLM経由）はスクリプトから呼ばない
- DB IDは `process.env.NOTION_DB_*` から取得する
