# iOS Shortcut「健康データ収集」セットアップ手順

毎日22:00に自動実行。Apple Health（体重・歩数・活動消費・ワークアウト・HRV）を
Notion APIに直接送信する。

---

## 事前準備

### Notion Integration Tokenの取得
1. https://www.notion.so/my-integrations を開く
2. 「+ 新しいインテグレーション」→ 名前: `HealthSync`
3. Capabilities: **Read content**, **Update content**, **Insert content** にチェック
4. Submit → 「内部インテグレーションシークレット」をコピー（`secret_xxx...`）
5. Notionで**健康ログDB**・**HRV記録DB**のページを開き、
   右上「...」→「コネクト」→ `HealthSync` を追加

### Notion DB ID（ページURLの末尾32文字）
- **健康ログDB**: `6a477b16d2ae4534baae49b31937d763`
- **HRV記録DB**: `b6922162c2514177a4d4f86623b9f9ff`

---

## Shortcutの作成手順

「ショートカット」アプリで新規作成。以下の順にアクションを追加する。

---

### [1] 変数設定

**「テキスト」アクション**:
```
secret_XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX
```
→ 変数に保存: `NotionToken`

**「テキスト」アクション**:
```
6a477b16d2ae4534baae49b31937d763
```
→ 変数に保存: `HealthLogDBID`

**「テキスト」アクション**:
```
b6922162c2514177a4d4f86623b9f9ff
```
→ 変数に保存: `HRVDBID`

---

### [2] 今日の日付取得

**「日付」アクション** → フォーマット: `yyyy-MM-dd` → 変数: `TodayStr`

---

### [3] Apple Healthから取得

**「ヘルスケアのサンプルを検索」** × 4回:

| # | データタイプ | 集計 | 変数名 |
|---|---|---|---|
| 1 | 体重 | 最新1件 | `WeightKg` |
| 2 | 歩数 | 合計（今日） | `StepCount` |
| 3 | アクティブエネルギー消費量 | 合計（今日） | `ActiveCalories` |
| 4 | ワークアウト | 全件（今日） | `Workouts` |

---

### [4] ワークアウトテキスト作成

**「繰り返し」** (Workoutsの各項目):
- テキスト: `[ワークアウトの種類] [継続時間]分 [消費カロリー]kcal`
- テキストを追加: 変数 `WorkoutText`

---

### [5] 健康ログDBにupsert

**「URLの内容を取得」**（Notion API PATCH/POST）:
- URL: `https://api.notion.com/v1/pages`
- メソッド: `POST`
- ヘッダー:
  - `Authorization`: `Bearer [NotionToken]`
  - `Notion-Version`: `2022-06-28`
  - `Content-Type`: `application/json`
- 本文（JSON）:
```json
{
  "parent": { "database_id": "[HealthLogDBID]" },
  "properties": {
    "日付": { "title": [{ "text": { "content": "[TodayStr]" } }] },
    "記録日": { "date": { "start": "[TodayStr]" } },
    "体重": { "number": [WeightKg] },
    "歩数": { "number": [StepCount] },
    "活動消費カロリー": { "number": [ActiveCalories] },
    "ワークアウト": { "rich_text": [{ "text": { "content": "[WorkoutText]" } }] }
  }
}
```

> **重複防止のヒント**: 実際には先にDBを `filter: { property: "日付", title: { equals: TodayStr } }` でクエリして、
> 既存エントリがあれば `PATCH /v1/pages/{page_id}` で更新するのが理想。
> Shortcutでは「URLの内容を取得」→ JSON解析→ 条件分岐で実装可能。

---

### [6] HRVサンプル取得

**「ヘルスケアのサンプルを検索」**:
- データタイプ: **心拍変動（SDNN）**
- 期間: 今日
- 結果: 全件 → 変数: `HRVSamples`

---

### [7] 各HRVサンプルをループしてNotionに書き込み

**「繰り返し」** (HRVSamplesの各項目):

1. **「テキスト」**: HRVサンプルの `開始日時` をISO8601形式で取得 → 変数: `HRVStartDate`
2. **「テキスト」**: HRVサンプルの `値` → 変数: `HRVValue`
3. **「テキスト」**: HRVサンプルの `ソース` → 変数: `HRVSource`

4. **既存チェック**（冪等）:
   - `POST https://api.notion.com/v1/databases/[HRVDBID]/query`
   - Body: `{"filter": {"property": "計測ID", "title": {"equals": "[HRVStartDate]"}}}`
   - → JSON解析 → `results` 配列が空かチェック → 変数: `HRVExists`（true/false）

5. **「もし」** `HRVExists` が false:
   - **「URLの内容を取得」** POST to `https://api.notion.com/v1/pages`:
   ```json
   {
     "parent": { "database_id": "[HRVDBID]" },
     "properties": {
       "計測ID": { "title": [{ "text": { "content": "[HRVStartDate]" } }] },
       "計測時刻": { "date": { "start": "[HRVStartDate]" } },
       "SDNN": { "number": [HRVValue] },
       "ソース": { "rich_text": [{ "text": { "content": "[HRVSource]" } }] }
     }
   }
   ```

---

### [8] 完了通知

**「通知を表示」**: `健康データをNotionに記録しました（HRV: [HRVSamplesの件数]件）`

---

## 自動実行の設定

1. ショートカットアプリ → 「オートメーション」タブ
2. 「+」→「個人用オートメーション」→「時刻」
3. 時刻: **22:00**、毎日
4. アクション: 作成したショートカットを実行
5. 「実行前に確認」: **オフ**（完全自動化）

---

## デバッグのヒント

- Shortcut内のAPI呼び出しが失敗する場合は「URLの内容を取得」の後に「クイックルック」を追加してレスポンスを確認
- Notion Integration TokenはDBに対して「コネクト」を追加していないと403エラーになる
- HRV計測値はApple Watchのマインドフルネスセッションや睡眠中に記録される。値がない日もある
