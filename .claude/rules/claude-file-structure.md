---
description: Claudeの行動をガイドするファイルを追加・編集するときのフォルダ構成ルール
---

# Claude関連ファイルの配置ルール

Claudeの動作をガイド・ハーネスするファイルを追加するときは、必ず以下の構成に従う。
参照: https://zenn.dev/stockdatalab/articles/20260401_tech_claudecode_files

## `.claude/` ディレクトリ構成

```
.claude/
├── rules/        # パス・ファイル種別ごとの細粒度ルール
├── skills/       # 再利用可能な手順（カスタムコマンド）
├── agents/       # 役割特化のサブエージェント定義
├── memory/       # メイン会話の自動メモリ（ユーザー設定・プロジェクト方針）
└── agent_memory/ # サブエージェント固有のメモリ
```

## 各ディレクトリの使い分け

| 追加したいもの | 置き場所 |
|---|---|
| 特定パスやファイル種別に適用するルール | `.claude/rules/<name>.md` |
| 繰り返し呼び出す手順・ワークフロー | `.claude/skills/<name>/SKILL.md` |
| 専門役割を持つサブエージェント | `.claude/agents/<name>.md` |
| セッションをまたいで保持したいプロジェクト知識 | `.claude/memory/<name>.md` |

## `CLAUDE.md` の役割

- プロジェクトの**概要・セットアップ・コマンド一覧**のみ記載
- 詳細ルールは `.claude/rules/` に分割して参照させる
- 長くなったら迷わず `.claude/` 配下に切り出す

## rules ファイルのフォーマット

```markdown
---
description: このルールが何をガイドするかの一行説明
paths:            # 省略すると全体に適用
  - "src/**"
---

# ルールタイトル

...内容...
```
