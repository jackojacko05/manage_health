# 毎時あすけんスクレイプ → Notion食事記録DB書き込み

## Notion DB情報
- **食事記録DB** (data source): `collection://8cc7bf9d-ee58-46e2-a732-9dab077f6b70`
- **健康ログDB** (data source): `collection://69b6d762-8fc3-4d84-8292-32d8f8605998`

## 手順

### Step 1: Playwrightスクレイプ実行

```bash
cd ~/GitHub/manage_health && /opt/homebrew/bin/npx tsx src/scrape-asken.ts 2>/dev/null
```

stdoutのJSONを取得する（stderrは無視）。JSONが空またはエラーの場合は終了。

出力形式:
```json
{
  "date": "YYYY-MM-DD",
  "entries": [
    {
      "division": "朝食",
      "name": "ごはん",
      "grams": 150,
      "calories": 252,
      "protein": 3.8,
      "fat": 0.5,
      "carbs": 55.7,
      "fiber": 0.5
    }
  ]
}
```

### Step 2: 今日の日付を確認

JSTの今日の日付を `YYYY-MM-DD` 形式で確認する（例: `2026-04-18`）。
Playwrightの出力JSONの `date` フィールドを使う。

### Step 3: 健康ログDBに今日のエントリがなければ作成

Notion食事記録DBを `date` が今日のものでクエリ。
健康ログDBを `日付 = today` でクエリして、なければ以下を作成:
- `日付`: `YYYY-MM-DD`（タイトル）
- `date:記録日:start`: `YYYY-MM-DD`
- `date:記録日:is_datetime`: 0

### Step 4: 既存の食事記録エントリのハッシュを取得

食事記録DBを以下の条件でクエリ:
- `date:検出時刻:start` が今日の日付で始まるもの（JSTで `YYYY-MM-DD`）

取得した全レコードの `ハッシュ` フィールドをSetとして保持する。

### Step 5: 差分検出 → 新規エントリ作成

各 `entry` について以下のハッシュを計算:

```
SHA1(division + "|" + name + "|" + grams)[0:8]
```

既存ハッシュSetに含まれないものだけを食事記録DBに作成:

| プロパティ | 値 |
|---|---|
| エントリID (title) | `"YYYY-MM-DD HH:MM name"` (JST) |
| `date:検出時刻:start` | 現在のJST日時 (ISO8601) |
| `date:検出時刻:is_datetime` | 1 |
| 食事区分 | entry.division |
| メニュー名 | entry.name |
| カロリー | entry.calories |
| タンパク質 | entry.protein |
| 脂質 | entry.fat |
| 炭水化物 | entry.carbs |
| 食物繊維 | entry.fiber |
| グラム | entry.grams |
| ハッシュ | 上記SHA1[0:8] |
| 日付 (relation) | 健康ログDBの今日エントリURL |

### Step 6: 完了ログ

新規作成したエントリ数をログに出力して終了。
差分がなければ「差分なし」と出力。

## 注意事項

- **append-only**: 既存エントリは絶対に変更しない
- **冪等**: 同じハッシュが既にあればスキップ
- **同じ夕食でも時刻が異なれば別レコード**: ハッシュが一致する場合のみスキップ
- storageStateがない場合は `npx tsx src/scrape-asken.ts --debug` で先にログインしてもらう必要あり
