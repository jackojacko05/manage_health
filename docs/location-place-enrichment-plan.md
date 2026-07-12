# Location Place Enrichment Implementation Plan

Status: implementation-ready plan

Owner repositories: `manage_health`, `obsidian`

Primary region/time zone: `asia-northeast1`, `Asia/Tokyo`

Last reviewed: 2026-07-13

## 1. Objective

OwnTracksの位置イベントを、本人が確認した意味ラベルへ安全に変換し、次の用途で使えるようにする。

1. Google Maps Platformの近隣施設を、未知地点の確認候補として表示する。
2. 確認された場所だけを`自宅`、`会社`、`ジム`などとしてBigQueryへ登録する。
3. 前日の出社・外出を、毎朝の日報の補助エビデンスにする。
4. 睡眠、HRV、歩数、運動と組み合わせ、負荷要因の候補として健康判断に使う。
5. 正確な座標、住所、移動経路をDiscord、Daily Note、LLM Wiki、Cloud Loggingへ出さない。

この計画では、Googleの検索結果を自動的に確定ラベルへ昇格させない。Google Placesは候補の発見に使い、確定は必ず本人の明示的な確認を必要とする。

## 2. Current State

2026-07-13時点の確認結果:

- `health.location_events`と`health.location_events_dedup`は稼働済み。
- `health.location_places`は存在するが、登録件数は0件。
- 直近の実データは2026-07-12の3イベント。すべて精度50m以内。
- OwnTracksはSignificant modeで動作している。
- `hae-receiver`は`_type=location`のみ保存し、`_type=transition`などは200で破棄する。
- `location-place-candidates.sql`はDBSCAN候補を出せるが、自動保存・確認フローはない。
- 朝の日報ディスパッチャーは睡眠を実行条件に使い、位置情報の決定的な要約は渡していない。

データがまだ少ないため、最初の自宅・会社登録は頻出クラスタの完成を待たず、本人が選んだ既存イベントまたはOwnTracks Regionからブートストラップできるようにする。

## 3. Scope

### Included

- OwnTracks `location`のRegion配列保存
- OwnTracks `transition`の受信と保存
- 確認済み場所との空間マッチ
- 未知地点クラスタの候補化
- Google Places API (New)のNearby Searchによるオンデマンド候補表示
- 候補から`location_places`への確認登録
- 日単位の意味的な位置エビデンス作成
- 朝の日報への位置エビデンス注入
- LLM Wikiの場所知識・健康判断ルール更新
- APIクォータ、監査、失敗時継続、テスト、復旧手順

### Excluded from v1

- 移動経路の地図表示
- 全イベントの逆ジオコーディング
- Google Mapsの個人用「保存済み」リストとの常時同期
- Google検索結果による自宅・会社の自動命名
- Significant modeの疎な点から正確な滞在時間を推定すること
- Googleの住所、施設名、施設種別、Maps URIをBigQueryへ長期保存すること
- リアルタイム通知や第三者との位置共有

## 4. Architectural Decision

```text
OwnTracks iPhone
  |  location / transition
  v
Cloud Run: hae-receiver
  |
  +--> health.location_events
  +--> health.location_transitions
  |
  v
BigQuery spatial processing
  +--> health.location_events_enriched
  +--> health.location_place_candidates
  +--> health.location_daily_context
            |
            +--> on-demand Google Places lookup
            |      +--> store Place IDs only
            |      +--> show Google names live for review
            |
            +--> user-confirmed health.location_places
            |
            +--> morning report runtime context
```

設計上の重要な境界:

- 座標の正本と空間計算はBigQuery `health`データセットに置く。
- Google Placesのレスポンスは表示時だけ使う。長期保存する外部識別子はPlace IDだけとする。
- 場所の`name`と`kind`は本人が採用したローカルラベルとする。
- 日報へ渡すのは`office_visit_status`などの意味データだけで、座標を渡さない。
- Google APIは全イベントではなく、ユーザーがレビューする未知候補に対してだけ呼ぶ。

## 5. BigQuery Data Contracts

すべて`jackojacko05.health`を本番の既定値とする。DDLでは既存の`__PROJECT__`、`__DATASET__`置換方式を維持する。

### 5.1 Extend `location_events`

既存テーブルへ次を追加する。

| Column | Type | Mode | Meaning |
|---|---|---|---|
| `in_region_ids` | `ARRAY<STRING>` | nullable | OwnTracks `inrids` |
| `in_region_names` | `ARRAY<STRING>` | nullable | OwnTracks `inregions` |

Rules:

- 配列に文字列以外が含まれる場合、その要素だけ破棄する。
- 空配列と欠測は分析上どちらも「Region情報なし」と扱う。
- Region名はBigQuery外へそのまま出さない。

### 5.2 Add `location_transitions`

```text
event_id             STRING      NOT NULL
captured_at          TIMESTAMP   NOT NULL
device_id            STRING      NOT NULL
tracker_id           STRING
region_id            STRING
region_description   STRING
transition_event     STRING      NOT NULL  -- enter | leave
latitude             FLOAT64
longitude            FLOAT64
accuracy_m           FLOAT64
trigger              STRING
waypoint_created_at  TIMESTAMP
source               STRING      NOT NULL  -- owntracks
received_at           TIMESTAMP   DEFAULT CURRENT_TIMESTAMP()
```

Storage:

- Partition: `DATE(captured_at)`
- Cluster: `device_id, region_id, transition_event`
- `require_partition_filter = TRUE`
- `event_id`は次の入力から決定的に生成する。

```text
owntracks-transition-v1
device_id
tracker_id
tst
region_id
transition_event
latitude
longitude
```

Validation:

- `_type`は`transition`。
- `event`は`enter`または`leave`のみ。
- `tst`は正のUnix epoch秒。
- `lat`、`lon`は両方欠測可能だが、片方だけ存在する場合は不正。
- 座標が存在する場合は通常の緯度経度範囲を検証する。
- `acc`は0以上のみ保存する。
- `rid`、`desc`は前後空白を除去し、空文字はNULLにする。

### 5.3 Extend `location_places`

既存の内部`place_id`は維持し、Google Place IDと混同しない。次を追加する。

| Column | Type | Meaning |
|---|---|---|
| `google_place_id` | `STRING` | 確認時に選択したGoogle Place ID |
| `owntracks_region_id` | `STRING` | OwnTracks Region ID |
| `registration_source` | `STRING` | `event`, `candidate`, `owntracks_region`, `manual` |
| `confirmed_by` | `STRING` | v1では`user`固定 |

`kind`はアプリケーション側で次に制限する。

```text
home
office
coworking
gym
healthcare
shopping
restaurant
transit
social
other
```

Rules:

- `place_id`は`pl_` + UUIDまたは決定的な安全なIDとし、Google Place IDを代用しない。
- `name`は本人が使う短いローカルラベル。例: `自宅`, `会社`, `ジム`。
- Googleの表示名を無確認で`name`へコピーしない。
- `radius_m`は25以上500以下。既定値100m。
- `active=true`にできるのは本人確認済みの行だけ。
- 同じ`google_place_id`または`owntracks_region_id`を複数のactive行へ割り当てない。
- 修正はDELETEではなく、旧行を`active=false`にして履歴を残す。

### 5.4 Add `location_place_candidates`

未知地点の内部候補を保存する。Googleの表示コンテンツは保存しない。

```text
candidate_id             STRING       NOT NULL
device_id                STRING       NOT NULL
centroid                 GEOGRAPHY    NOT NULL
suggested_radius_m       FLOAT64      NOT NULL
sample_count             INT64        NOT NULL
active_days              INT64        NOT NULL
first_seen               TIMESTAMP    NOT NULL
last_seen                TIMESTAMP    NOT NULL
median_accuracy_m        FLOAT64
status                   STRING       NOT NULL
google_place_ids         ARRAY<STRING>
selected_google_place_id STRING
confirmed_place_id       STRING
lookup_count             INT64        NOT NULL
last_lookup_at           TIMESTAMP
last_error_code          STRING
created_at               TIMESTAMP    NOT NULL
updated_at               TIMESTAMP    NOT NULL
```

Allowed `status`:

```text
new
needs_review
confirmed
rejected
no_results
lookup_failed
superseded
```

Rules:

- `centroid`と精度は機微情報として`health`内だけに置く。
- Googleから保存するのは`google_place_ids`だけ。
- `selected_google_place_id`は本人が選択した後だけ設定する。
- `confirmed_place_id`は`location_places.place_id`を参照する論理外部キー。
- 再計算で100m以内の既存候補があれば同一候補として更新する。
- 100m以内に複数候補がある場合は最新ではなく最短距離を選び、同距離なら古い候補を優先する。

### 5.5 Add `location_enrichment_runs`

API本文や座標を含まない運用ログ。

```text
run_id              STRING       NOT NULL
run_type            STRING       NOT NULL  -- discover | lookup | confirm
started_at          TIMESTAMP    NOT NULL
finished_at         TIMESTAMP
status              STRING       NOT NULL  -- running | success | partial | failed
candidates_scanned  INT64
candidates_created  INT64
api_call_count      INT64
success_count       INT64
failure_count       INT64
error_codes         ARRAY<STRING>
```

### 5.6 Add `location_events_enriched` view

Grain: deduplicated location event.

Output must include:

```text
event_id
captured_at
device_id
accuracy_m
matched_place_id
matched_place_name
matched_place_kind
match_distance_m
match_confidence
match_method
```

It must not expose latitude, longitude, `GEOGRAPHY`, address, or Google display content.

Matching algorithm:

1. Base scan always contains a bounded `captured_at` predicate in consuming queries.
2. Ignore spatial matching when `accuracy_m > 100`.
3. Join only `location_places.active = TRUE`.
4. Match when event point is within `radius_m` of a place center.
5. If multiple places match, choose the shortest `ST_DISTANCE`.
6. If a transition Region ID maps to a confirmed place, Region ID wins over point distance for the same time context.
7. `match_confidence`:
   - `high`: confirmed Region enter/leave, or point accuracy <= 50m and inside radius.
   - `medium`: point accuracy is NULL or 50m < accuracy <= 100m and inside radius.
   - `none`: no match.
8. `match_method`: `region`, `point`, or `none`。

The view may contain the local semantic name because it is user-owned data, but downstream daily reporting should normally use `kind`, not a specific name.

### 5.7 Add `location_daily_context` view

Grain: JST calendar date + device.

```text
context_date              DATE
device_id                 STRING
event_count               INT64
accurate_event_count      INT64
transition_count          INT64
first_observed_at         TIMESTAMP
last_observed_at          TIMESTAMP
observed_place_kinds      ARRAY<STRING>
office_visit_status       STRING
home_observation_status   STRING
late_return_status        STRING
data_quality              STRING
evidence_codes            ARRAY<STRING>
generated_at              TIMESTAMP
```

No coordinates, addresses, routes, Google display names, or exact company names may appear in this view.

#### Data quality

```text
none:
  event_count = 0 and transition_count = 0

sparse:
  1-2 accurate events and transition_count = 0

partial:
  at least 3 accurate events or at least 1 valid transition

good:
  at least 2 valid transitions, or
  at least 6 accurate events spanning at least 6 hours
```

#### Office visit status

```text
confirmed:
  at least one enter transition for an active office/coworking place, or
  at least two high-confidence point matches separated by at least 15 minutes

possible:
  exactly one high-confidence point match, or
  at least one medium-confidence point match

no_evidence:
  data_quality in (partial, good) and no office evidence

insufficient_data:
  data_quality in (none, sparse) and no office evidence
```

`no_evidence`は「出社していない」を意味しない。日報では否定の根拠に使わない。

#### Late return status

v1ではRegion transitionがある場合だけ判定する。

```text
late:
  最後のhome enterがJST 21:00以降

not_late:
  最後のhome enterがJST 21:00より前

unknown:
  home enterがない
```

位置点だけから帰宅時刻を推定しない。

## 6. Candidate Discovery

候補発見はGoogle APIを呼ばず、BigQuery内だけで日次実行する。

### Input window

- Default:直近14日
- Maximum:直近30日
- Base table predicateはUTCパーティションを含む。
- `accuracy_m IS NULL OR accuracy_m <= 100`のみ使用する。
- 既知のactive place内にある点を除外する。

### Clustering

既存`ST_CLUSTERDBSCAN`方式を再利用する。

```text
epsilon: 150m
minimum geography count: 3
```

初期データが少ないため、候補作成条件は次とする。

```text
sample_count >= 3
OR active_days >= 2
```

Candidate IDはクラスタ番号を使わない。クラスタ番号はクエリごとに変わり得るためである。

Upsert procedure:

1. 各クラスタのcentroidを計算する。
2. 同じdeviceの既存`new`または`needs_review`候補を100m以内で検索する。
3. 最短の候補があれば、件数、期間、centroidを更新する。
4. なければランダムUUIDベースの`candidate_id`を作る。
5. 確認済み・却下済み候補は自動的に再オープンしない。
6. 確認済み場所のradius内へ入った候補は`superseded`へ変更する。

### Bootstrap path

クラスタ条件を満たさなくても本人が現在地を登録できるよう、管理CLIに次を用意する。

```text
register-from-event --event-id EVENT_ID
```

このコマンドはBigQueryから座標を取得し、コマンドライン引数やログに座標を出さない。ユーザーは`name`、`kind`、`radius_m`を入力して確認する。

## 7. Google Places Integration

### API

- Product: Places API (New)
- Method: `POST https://places.googleapis.com/v1/places:searchNearby`
- Authentication: dedicated API key loaded from Secret Manager
- Secret name: `google-maps-places-api-key`
- API restriction: Places API (New) only
- Application restriction: server-side restriction supported by the chosen network setup. If fixed egress IP is not configured, at minimum apply the API restriction and strict quotas.

### Request contract

```json
{
  "maxResultCount": 5,
  "rankPreference": "DISTANCE",
  "locationRestriction": {
    "circle": {
      "center": {
        "latitude": "FROM_BIGQUERY_CANDIDATE",
        "longitude": "FROM_BIGQUERY_CANDIDATE"
      },
      "radius": "DYNAMIC_RADIUS"
    }
  },
  "languageCode": "ja",
  "regionCode": "JP"
}
```

Field mask:

```text
places.id,
places.displayName,
places.primaryType,
places.formattedAddress,
places.googleMapsUri,
places.location
```

The production header must contain the same list without spaces or line breaks.

Dynamic search radius:

```text
max(50m, min(200m, suggested_radius_m + median_accuracy_m))
```

If `median_accuracy_m` is NULL, treat it as 25m.

### Persistence policy

Persist:

- Place ID
- lookup timestamp
- lookup count
- generic API status/error code

Do not persist:

- Google display name
- formatted address
- Google coordinates
- Google types
- Google Maps URI
- raw request or response body

Candidate names and addresses are fetched live and displayed with `Google Maps` attribution. When the user confirms a candidate, persist the user's own label and the centroid calculated from the user's OwnTracks data. Do not persist Google's coordinates as the local place center.

Place IDs may be retained. Add a maintenance command to refresh IDs older than 12 months using an IDs-only Place Details request.

### Invocation policy

v1 uses on-demand lookup only.

- Daily discovery creates BigQuery candidates without calling Google.
- The user or an authorized agent runs `lookup --candidate-id ...`.
- One lookup makes exactly one Nearby Search request and returns at most five results.
- Re-running the same candidate is allowed only with `--refresh` within 24 hours.
- Default expected use is fewer than 100 requests/month.
- Do not implement automatic lookup for every event.

### Error handling

```text
HTTP 200:
  parse response; store Place IDs; status needs_review or no_results

HTTP 400/401/403:
  do not retry; status lookup_failed; store generic error code

HTTP 429/500/502/503/504:
  retry at most 3 attempts with exponential backoff and jitter

network timeout:
  10 seconds per request; retry under the same 3-attempt budget
```

Never log API keys, coordinates, addresses, display names, or raw response bodies.

## 8. Admin CLI Contract

Add a non-interactive, scriptable TypeScript CLI under `hae-receiver` so Codex or another agent can use it safely.

Planned file:

```text
hae-receiver/src/location-place-admin.ts
```

Commands:

```text
discover --start-date YYYY-MM-DD --end-date YYYY-MM-DD [--dry-run]

list [--status new,needs_review] [--limit 20]

recent-events [--days 2] [--limit 20]

lookup --candidate-id CANDIDATE_ID [--refresh] [--json]

confirm --candidate-id CANDIDATE_ID
        --google-place-id GOOGLE_PLACE_ID
        --name LOCAL_LABEL
        --kind KIND
        [--radius-m 100]

reject --candidate-id CANDIDATE_ID --reason REASON

register-from-event --event-id EVENT_ID
                    --name LOCAL_LABEL
                    --kind KIND
                    [--radius-m 100]

deactivate --place-id INTERNAL_PLACE_ID

refresh-place-ids [--older-than-days 365] [--dry-run]
```

Safety requirements:

- `list` must not print coordinates.
- `recent-events` prints only event ID, JST timestamp, device ID, accuracy, and whether the event already matches a place. It must not print coordinates.
- `lookup` may print Google name, coarse address, type, distance, and Maps link, with `Source: Google Maps` attribution.
- `confirm` only accepts a Google Place ID returned for the same candidate unless `--force` is supplied.
- `--force` requires an explicit `--reason` and is still prohibited from accepting coordinates.
- All mutating commands support `--dry-run` except `lookup` because lookup is an external billable call.
- Mutating commands print the internal candidate/place ID and semantic fields, never coordinates.
- `confirm` writes `location_places` and closes the candidate in one BigQuery multi-statement transaction. A partial confirmation is not allowed.
- API key is read directly from Secret Manager into process memory.
- No secret is written to `.env`, command history, temporary files, or BigQuery.
- Exit codes: 0 success, 2 validation error, 3 not found/conflict, 4 external API error, 5 BigQuery error.

Package scripts:

```json
{
  "location:admin": "node dist/location-place-admin.js",
  "location:discover": "node dist/location-place-admin.js discover"
}
```

## 9. OwnTracks Region Support

Reliable office/home evidence requires Region enter/leave events because Significant mode can omit stationary points.

### Receiver changes

`POST /owntracks` must route by `_type`:

```text
location   -> parseOwnTracksLocation -> location_events
transition -> parseOwnTracksTransition -> location_transitions
other      -> acknowledge [] without persistence
```

The response remains `[]` for successfully accepted messages and valid ignored messages.

Add support for `inrids` and `inregions` on location payloads.

### iPhone configuration

After the first places are confirmed:

1. Create OwnTracks Region for `自宅` and `会社`.
2. Use 100-150m initially; avoid overlapping regions.
3. Keep Significant mode.
4. Trigger a manual publish after Region creation.
5. Confirm the first enter/leave event in BigQuery without displaying coordinates.
6. Associate the observed `rid` with `location_places.owntracks_region_id`.

Do not rely on `desc` alone because the description is editable. Prefer stable `rid` after it is known.

## 10. Daily Report Integration

The report must receive a deterministic semantic summary instead of querying raw coordinates.

### Dispatcher behavior

In `obsidian/Tools/personal_ai/scripts/daily_report_dispatch.py`:

1. Keep the sleep candidate query as the delivery gate.
2. After a sleep candidate is ready, query `health.location_daily_context` for `REPORT_DATE - 1 DAY` in JST.
3. Attach a normalized location object to the candidate passed to `report_prompt`.
4. If the location query fails, continue the report with `availability=unavailable`.
5. A location failure must not block a sleep-ready daily report.

Runtime context contract:

```text
LOCATION_EVIDENCE_DATE: YYYY-MM-DD
LOCATION_AVAILABILITY: available | unavailable
LOCATION_DATA_QUALITY: none | sparse | partial | good
LOCATION_OFFICE_VISIT_STATUS: confirmed | possible | no_evidence | insufficient_data
LOCATION_HOME_OBSERVATION_STATUS: observed | possible | no_evidence | insufficient_data
LOCATION_LATE_RETURN_STATUS: late | not_late | unknown
LOCATION_OBSERVED_PLACE_KINDS: JSON array of semantic kinds
LOCATION_EVIDENCE_CODES: JSON array of bounded codes
```

Prohibited runtime fields:

- latitude/longitude
- GEOGRAPHY/WKT/geohash
- exact address
- route
- Google display name
- Google Maps URL
- exact home/company local label

### Prompt rules

Update `morning_report_prompt.md`:

- Use location only for the day before `REPORT_DATE`.
- `confirmed` office evidence may be reported as `昨日は出社`。
- `possible` must be phrased as `出社の可能性`。
- `no_evidence` must not be phrased as `出社していない`。
- `insufficient_data` should normally be omitted from the short Discord report.
- Office evidence alone must not produce `疲れている`。
- Preferred phrasing: `出社・移動負荷が疲労要因の候補`。
- Recovery advice requires corroboration from at least one of sleep, HRV, steps, workout, late return, or the user's subjective report.
- Do not diagnose or infer mood, stress, productivity, or interpersonal events from location.
- Discord and Daily Note must not contain exact address or coordinates.

Example allowed output:

```text
- 昨日は出社を確認。歩数も多く、移動負荷は高め。
- 睡眠が短くHRVも低めなので、今日は回復を優先。
```

Example prohibited output:

```text
- 会社に行ったので疲れている。
- 昨日は緯度35.x、経度139.xの○○ビルに8時間滞在した。
```

### Logging

Keep `personal_ai.daily_reports` schema unchanged in v1. Add only these semantic values to the existing `raw_json` payload:

```text
location_evidence_date
location_data_quality
location_office_visit_status
location_evidence_ref
```

`location_evidence_ref` format:

```text
jackojacko05.health.location_daily_context:YYYY-MM-DD:DEVICE_ID
```

Do not copy coordinates or place labels into the daily report log payload.

## 11. Health Reasoning Policy

Update `obsidian/LLM Wiki/Health and Life Context.md` with the following durable rules:

1. Location is behavioral context, not a health measurement.
2. Office attendance is a possible load factor, not proof of fatigue.
3. Use `office confirmed + one corroborating signal` before recommending recovery based on commute/work context.
4. Give greater weight to the user's subjective report than to inferred location context.
5. Treat missing location as missing data, not staying home.
6. Avoid single-day causal claims; trends require multiple observed days.

Update `obsidian/LLM Wiki/Location and Places.md` only after places are confirmed:

- Add semantic place name and kind.
- Add allowed context, confidence, and confirmation date.
- Never add coordinates, address, Region ID, Google Place ID, or raw event times.

## 12. Scheduling and Cost Controls

### Candidate discovery schedule

- Runtime: Cloud Run Job or an existing private scheduled environment.
- Recommended job name: `location-place-discovery`
- Schedule: daily at 03:30 JST
- Window: rolling 14 days
- Google API calls: zero
- Maximum runtime: 5 minutes
- Retries: one platform retry

The first implementation may run the discovery CLI manually. Scheduling is enabled only after scratch-dataset validation.

### Google API limits

At deployment time:

- Enable only Places API (New) for the dedicated key.
- Set a low Nearby Search daily quota, target 100/day or lower if the console permits.
- Add billing budget alerts. Budget alerts do not stop spend, so quotas remain mandatory.
- Emit `api_call_count` in `location_enrichment_runs`.
- Alert or fail closed if the process attempts more than 20 lookups in one execution.

Expected normal use:

```text
Nearby Search: fewer than 100 calls/month
Place Details: only live review or annual ID refresh
BigQuery: bounded 14-day scans over a small personal table
```

## 13. Security and Privacy

### IAM

Receiver service account:

- BigQuery Data Editor on `health`
- Secret Accessor for existing OwnTracks auth secret
- No Places key access unless receiver itself needs it; v1 receiver does not

Admin/discovery identity:

- BigQuery Data Viewer/Data Editor on required `health` objects
- Secret Accessor only for `google-maps-places-api-key`
- No broader Secret Manager access

### Data handling

- Exact location remains in private BigQuery tables.
- Do not put location tables in Supabase FDW.
- Do not expose raw location through BigQuery MCP views intended for general agents.
- Do not log request payloads, coordinates, Google response bodies, addresses, or place names.
- Do not commit API keys, tokens, user coordinates, example home/work addresses, or real Place IDs.
- Tests use fictional coordinates and fictional Place IDs.
- Candidate and place mutations are auditable through timestamps and run rows.

### External disclosure

Google receives only the centroid of a candidate explicitly looked up by the user or authorized agent. Google does not receive the full route or all OwnTracks events.

## 14. File-by-File Implementation Map

### `manage_health`

Modify:

- `hae-receiver/src/index.ts`
  - Parse Region arrays.
  - Add transition parser and route.
  - Insert transition rows without sensitive logging.
- `hae-receiver/src/index.test.ts`
  - Add location Region and transition tests.
- `hae-receiver/package.json`
  - Add admin CLI scripts.
- `sql/native-ddl.sql`
  - Add Bronze columns/tables.
  - Extend `location_places`.
- `scripts/apply-bigquery.sh`
  - Add `location` action and include it in `all`.
- `REPRODUCIBILITY.md`
  - Add location DDL/assertion/admin commands.
- `AGENTS.md`
  - Add new Bronze/Silver/Gold objects and privacy rules.
- `docs/owntracks-location.md`
  - Add Region setup, transition verification, Places review workflow.
- `.env.example`
  - Document non-secret configuration names only.

Add:

- `hae-receiver/src/location-place-admin.ts`
- `hae-receiver/src/location-place-admin.test.ts`
- `hae-receiver/src/google-places.ts`
- `hae-receiver/src/google-places.test.ts`
- `sql/location-ddl.sql`
- `sql/location-assertions.sql`
- `sql/queries/location-daily-context.sql`
- `scripts/deploy-location-place-discovery.sh`

Do not edit or stage unrelated dirty files. Use explicit paths with `git add`.

### `obsidian`

Modify:

- `Tools/personal_ai/scripts/daily_report_dispatch.py`
- `Tools/personal_ai/scripts/test_daily_report_dispatch.py`
- `Tools/personal_ai/scripts/morning_report_prompt.md`
- `LLM Wiki/Location and Places.md`
- `LLM Wiki/Health and Life Context.md`
- `LLM Wiki/Data Sources.md`
- `HERMES.md` if table allowlists or query policy need the new semantic view

Do not modify historical Daily Notes during deployment tests.

## 15. Test Plan

### TypeScript unit tests

Receiver:

- Valid transition enter parses correctly.
- Valid transition leave parses correctly.
- Retry produces the same event ID.
- Unsupported transition event is rejected with a bounded reason.
- Missing timestamp is rejected.
- One-sided latitude/longitude is rejected.
- Coordinates are optional only as a pair.
- Device ID uses `X-Limit-D`, topic, tracker ID, then `unknown` in that order.
- `inrids`/`inregions` accept only trimmed strings.
- Non-location/non-transition messages are acknowledged without writes.

Places client:

- Sends the exact production field mask.
- Limits results to five and ranks by distance.
- Uses dynamic radius bounds of 50-200m.
- Does not include API key or coordinates in errors.
- Retries only retryable HTTP codes, at most three attempts.
- Parses Place IDs separately from display content.
- Persists only Place IDs.
- Empty response becomes `no_results`.

Admin CLI:

- Rejects unknown kinds.
- Rejects radius outside 25-500m.
- Rejects confirmation with an unrelated Google Place ID.
- Dry-run performs no mutation.
- Register-from-event never prints coordinates.
- Confirm creates one active place and closes the candidate atomically.
- Repeated confirm is idempotent or returns a conflict without duplicates.

### BigQuery SQL assertions

Use synthetic temporary data and fail the script if any assertion returns a row.

- Duplicate location events dedupe by latest `received_at`.
- Point inside one place matches it.
- Overlapping places choose the closest.
- Accuracy over 100m does not match.
- Region ID match takes precedence.
- JST 00:00 boundary assigns the correct `context_date`.
- Two office hits 15 minutes apart produce `confirmed`.
- One office hit produces `possible`.
- Sparse/no evidence produces `insufficient_data`.
- Partial/no office evidence produces `no_evidence`, not absence.
- Home enter after 21:00 produces `late`.
- Daily context schema contains no coordinate/address columns.

### Python dispatcher tests

- Queries exactly `REPORT_DATE - 1 day`.
- Adds semantic location context to the prompt.
- Never adds coordinates or addresses.
- Location query failure still sends a sleep-ready report.
- `possible` remains uncertain in the generated instructions.
- `no_evidence` is not translated to non-attendance.
- Existing sent-marker retry behavior remains unchanged.

### Integration checks

```bash
cd hae-receiver
npm test

GCP_PROJECT_ID=SCRATCH_PROJECT_OR_PROJECT \
BQ_DATASET=health_location_test \
BQ_LOCATION=asia-northeast1 \
../scripts/apply-bigquery.sh --dry-run location

python3 -m unittest \
  /absolute/path/to/obsidian/Tools/personal_ai/scripts/test_daily_report_dispatch.py
```

Then apply to a scratch dataset, insert fictional test data, and run `location-assertions.sql` before production DDL.

## 16. Deployment Sequence

### Phase 0: Repository safety

1. Record `git status --short` in both repositories.
2. Identify pre-existing dirty files.
3. Work only on paths listed in this plan.
4. Never run `git add -A`, `git reset --hard`, or checkout unrelated files.

### Phase 1: BigQuery contracts

1. Add Bronze schema changes and location DDL.
2. Add SQL assertions.
3. Dry-run DDL.
4. Apply to scratch dataset.
5. Run assertions.
6. Inspect schemas and descriptions.
7. Apply production DDL only after scratch success.

Gate:

- Existing `location_events` rows remain readable.
- Existing receiver continues to insert location rows.
- No destructive table replacement.

### Phase 2: Receiver transitions

1. Implement parser and tests.
2. Run `npm test`.
3. Deploy `hae-receiver`.
4. Send fictional authenticated transition payload or use a test Region.
5. Verify one row without selecting coordinates.
6. Confirm Cloud Logging contains only event ID and status.

Gate:

- Location ingestion remains healthy.
- Transition retries do not duplicate semantic events.
- Unsupported OwnTracks messages remain acknowledged.

### Phase 3: Candidate discovery and admin CLI

1. Implement discovery SQL and CLI.
2. Implement Secret Manager-backed Places client.
3. Create a dedicated restricted Places API key.
4. Store it in `google-maps-places-api-key`.
5. Run discovery against the bounded production window in dry-run.
6. Run one candidate lookup.
7. Verify only Place IDs were stored.
8. Confirm one place with a user-owned label.

Gate:

- No Google content columns exist in candidate/place tables.
- No API key or coordinates appear in logs or Git diff.
- One lookup creates at most one billable Nearby Search request, excluding documented retries.

### Phase 4: Bootstrap home and office

Because the current dataset has only three events, use either candidate confirmation or `register-from-event`.

1. Select an event by event ID and timestamp, not by printing coordinates.
2. Ask the user whether it is home, office, or another place.
3. Register local name/kind/radius.
4. Add matching OwnTracks Region in the iPhone app.
5. Observe the first transition.
6. Bind Region ID to the internal place.
7. Repeat for the second essential place.

Gate:

- The user explicitly confirms every active place.
- No exact coordinate/address enters the Wiki or chat summary.

### Phase 5: Daily semantic context

1. Deploy enriched and daily context views.
2. Test at least: confirmed, possible, no evidence, insufficient data.
3. Observe seven days without using the result in health advice.
4. Compare Region events with the user's recollection.
5. Adjust radius only with explicit confirmation.

Gate:

- False office confirmations are zero in the observation window.
- Missing data never becomes non-attendance.

### Phase 6: Morning report

1. Extend dispatcher query and runtime contract.
2. Add tests for optional failure behavior.
3. Update prompt and Wiki policies.
4. Run dispatcher in check/test mode.
5. Inspect generated prompt for prohibited data.
6. Enable location evidence with a feature flag.

Feature flag:

```text
DAILY_REPORT_LOCATION_EVIDENCE=0 | 1
```

Default during rollout: `0`. Set to `1` after the seven-day validation gate.

### Phase 7: Scheduling and monitoring

1. Deploy/schedule daily discovery.
2. Confirm it makes zero Google calls.
3. Configure API quotas and billing alerts.
4. Document monthly review query for API call count.
5. Review candidate backlog and false positives after 30 days.

## 17. Rollback

Morning report:

- Set `DAILY_REPORT_LOCATION_EVIDENCE=0`.
- Do not delete daily context data.
- Sleep-gated reporting continues without location.

Candidate discovery:

- Pause Cloud Scheduler job.
- Existing candidates remain for audit.

Google integration:

- Disable/restrict the API key.
- Admin CLI lookup fails closed; BigQuery location ingest continues.

Incorrect place:

- Set `location_places.active=false`.
- Mark linked candidate `rejected` or reopen it deliberately.
- Rebuild semantic views; do not delete raw events.

Receiver regression:

- Deploy the previous Cloud Run revision.
- Transition messages may be temporarily ignored, but location ingestion must remain available.

## 18. Commit Boundaries

Keep repositories and concerns separate.

Suggested `manage_health` commits:

1. `Add location transition and enrichment schemas`
2. `Ingest OwnTracks region transitions`
3. `Add safe Google Places candidate review`
4. `Add daily semantic location context`
5. `Document location enrichment operations`

Suggested `obsidian` commit:

1. `Use semantic location evidence in morning reports`

Each commit must stage explicit files only. Before commit, run `git diff --check` and the relevant tests.

## 19. Definition of Done

The implementation is complete only when all conditions below are true.

- OwnTracks location and transition messages are accepted and deduplicated.
- At least one user-confirmed place can be registered without exposing coordinates.
- Nearby Search returns at most five live Google Maps candidates.
- BigQuery stores Google Place IDs but no long-lived Google display content.
- All active semantic places have explicit user confirmation.
- Daily context produces stable statuses for synthetic test cases.
- Morning report receives only semantic location fields.
- Location lookup/report failures do not break OwnTracks ingestion or a sleep-ready report.
- Office attendance alone never becomes a fatigue diagnosis.
- API key is restricted and stored only in Secret Manager.
- Nearby Search quota and billing alerts are configured.
- No exact locations, addresses, real Place IDs, or secrets appear in Git, Markdown, Discord, or Cloud Logging.
- TypeScript, SQL assertions, and Python tests pass.
- Production rollout has a documented feature flag and rollback path.
- The user validates home/office behavior over at least seven days before health advice is enabled.

## 20. Agent Handoff Checklist

An implementing agent should execute in this order:

1. Read this plan plus `AGENTS.md`, `REPRODUCIBILITY.md`, and `docs/owntracks-location.md`.
2. Inspect both repository worktrees and preserve unrelated changes.
3. Implement Phase 1 only; test in scratch BigQuery.
4. Implement Phase 2; deploy and verify transitions.
5. Implement Phase 3; perform one controlled Places lookup.
6. Stop for explicit user confirmation before activating any semantic place.
7. Bootstrap Regions and collect seven days of evidence.
8. Implement daily context and validate against user recollection.
9. Implement report integration behind the disabled feature flag.
10. Enable only after all Definition of Done checks pass.

No agent may skip the explicit confirmation gate, silently auto-label a place, or send raw coordinates to an LLM to accelerate implementation.

## 21. Primary References

- Google Places Nearby Search (New): https://developers.google.com/maps/documentation/places/web-service/nearby-search
- Google Places usage and billing: https://developers.google.com/maps/documentation/places/web-service/usage-and-billing
- Google Maps Platform pricing: https://developers.google.com/maps/billing-and-pricing/pricing
- Google Maps API security: https://developers.google.com/maps/api-security-best-practices
- Google Places policies: https://developers.google.com/maps/documentation/places/web-service/policies
- Google Place ID retention: https://developers.google.com/maps/documentation/places/web-service/place-id
- OwnTracks HTTP: https://owntracks.org/booklet/tech/http/
- OwnTracks JSON transition schema: https://owntracks.org/booklet/tech/json/
- OwnTracks Regions/Waypoints: https://owntracks.org/booklet/features/waypoints/
