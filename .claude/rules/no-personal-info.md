---
description: 個人情報・環境固有の値をリポジトリに含めることを禁止するルール
---

# 個人情報・環境固有値の禁止

このリポジトリは誰でもcloneして自分の環境で動かせる汎用コードのみを含む。
個人・環境を特定できる情報は一切commitしない。

## commitしてはいけないもの

| 種別 | 例 | 正しい置き場 |
|---|---|---|
| 認証情報 | メールアドレス、パスワード | `.env`（gitignored） |
| APIトークン | Notion Token (`secret_...`、`ntn_...`) | `.env`（gitignored） |
| DB / リソースID | Notion DB ページID、Collection ID | `.env`（gitignored） |
| セッション情報 | `data/storageState.json` | `data/`（gitignored） |
| 個人の記録データ | 食事記録、体重、HRV値 | Notionのみ |

## コード内でのID・トークンの扱い

- ソースコード（`.ts`、`.md` 等）に実値をハードコードしない
- 必ず `process.env.VARIABLE_NAME` 経由で読み込む
- 追加した環境変数は `.env.example` にプレースホルダーで記載する

```typescript
// ✗ NG
const DB_ID = '6a477b16d2ae4534baae49b31937d763';

// ✓ OK
const DB_ID = process.env.NOTION_DB_HEALTH_LOG ?? '';
```

## コミット前のチェックリスト

- [ ] `git diff --staged` で個人情報が含まれていないか確認
- [ ] 新しい環境変数を追加した場合、`.env.example` にプレースホルダーを追記した
- [ ] `.env`・`data/storageState.json` が staged に含まれていない
