---
description: Git ブランチ運用ルール
---

# Git ワークフロー

## ブランチ運用

- **main へ直接コミットしない**
- 新しい機能・修正を開発するときは必ずブランチを切る
- ブランチ名は開発内容がわかるようにする（日本語不可）

### ブランチ名の例

| 作業内容 | ブランチ名 |
|---|---|
| 新機能追加 | `feature/<内容>` （例: `feature/advice-fields`） |
| バグ修正 | `fix/<内容>` （例: `fix/date-timezone`） |
| リファクタリング | `refactor/<内容>` |
| ドキュメント | `docs/<内容>` |

```bash
# ✓ OK
git checkout -b feature/meal-advice

# ✗ NG（main に直接作業）
git checkout main
# ... 直接コミット
```

## マージ・PR

- 作業が完了したら main に PR を出す（直接 merge より PR 推奨）
- PR タイトルは変更内容が一目でわかるように
