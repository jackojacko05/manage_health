# Read BigQuery from Supabase (and ChatGPT) via FDW

Goal: query the same `health` BigQuery dataset from Supabase's PostgREST
API — primarily so external Postgres-aware tools (e.g. **ChatGPT's
Supabase connector**) can hit it without any data duplication or sync
job.

Approach: Supabase's `wrappers` extension provides a **BigQuery Foreign
Data Wrapper (FDW)**. Foreign tables in Supabase point at **recent-90d
views defined on the BigQuery side**, where the date predicate is
evaluated by BigQuery itself and partition-pruning works under
`require_partition_filter = TRUE`. Auth is `authenticated`-only:
ChatGPT signs in to your Supabase project with email + password, no
data is reachable through the publishable / anon key alone.

Why not batch sync? See `decisions/006-supabase-fdw-over-sync.md`.

## Prereqs

- Working pipeline from `setup.md` (BQ dataset `health` populated, four
  time-series tables present, `require_partition_filter = TRUE`).
- A Supabase project (any plan; FDW is on free tier).
- `gcloud` configured for the GCP project.

## 1. Create a read-only GCP service account

The FDW authenticates to BigQuery using a service account key. Don't
reuse the Cloud Run service account — keep the FDW reader narrowly
scoped.

```bash
gcloud iam service-accounts create supabase-bq-reader \
  --project="$GCP_PROJECT_ID" \
  --display-name="Supabase BigQuery FDW reader"

SA="supabase-bq-reader@${GCP_PROJECT_ID}.iam.gserviceaccount.com"

gcloud projects add-iam-policy-binding "$GCP_PROJECT_ID" \
  --member="serviceAccount:${SA}" \
  --role="roles/bigquery.jobUser" --condition=None

# Limit the data-access role to the health dataset only.
# Use `bq update` with the JSON ACL to add a READER entry.
TMP=$(mktemp)
bq --project_id="$GCP_PROJECT_ID" show --format=prettyjson \
   "${GCP_PROJECT_ID}:${BQ_DATASET}" > "$TMP"
python3 - "$TMP" "$SA" <<'PY'
import json, sys
path, sa = sys.argv[1], sys.argv[2]
d = json.load(open(path))
if not any(a.get("userByEmail") == sa for a in d.get("access", [])):
    d["access"].append({"role": "READER", "userByEmail": sa})
    json.dump(d, open(path, "w"))
PY
bq --project_id="$GCP_PROJECT_ID" update --source "$TMP" \
   "${GCP_PROJECT_ID}:${BQ_DATASET}"
rm "$TMP"

# Generate the JSON key — copy it; you'll paste it into Supabase Vault.
gcloud iam service-accounts keys create ~/sa-supabase-bq.json \
  --iam-account="$SA" --project="$GCP_PROJECT_ID"
```

`bigquery.jobUser` (project-level) lets the FDW run query jobs.
`READER` on the dataset is what reads rows; least privilege.

## 2. Make sure the BQ recent-90d views exist

`sql/native-ddl.sql` defines four `*_recent_90d` views in the `health`
dataset. They wrap the four time-series tables with a
`WHERE DATE(...) >= DATE_SUB(CURRENT_DATE(), INTERVAL 90 DAY)` clause.
BQ evaluates `CURRENT_DATE()` server-side before partition pruning, so
the underlying `require_partition_filter` is satisfied.

If you set up your project before these views existed, re-apply the DDL
(it's idempotent — `CREATE OR REPLACE VIEW`):

```bash
sed "s/__PROJECT__/${GCP_PROJECT_ID}/g" sql/native-ddl.sql \
  | bq query --project_id="$GCP_PROJECT_ID" --nouse_legacy_sql
```

Verify:

```bash
for V in heart_rate_recent_90d hrv_recent_90d raw_metrics_recent_90d workouts_recent_90d; do
  bq query --project_id="$GCP_PROJECT_ID" --nouse_legacy_sql --format=csv --quiet \
    "SELECT '${V}' AS v, COUNT(*) AS n FROM \`${GCP_PROJECT_ID}.health.${V}\`"
done
```

## 3. Enable extensions in Supabase

In Supabase Dashboard → **Database → Extensions**, enable:

- `wrappers` (the FDW host)
- `supabase_vault` (usually already on)

## 4. Store the SA key in Vault

In Supabase **SQL Editor**:

```sql
SELECT vault.create_secret(
  $$ <PASTE THE WHOLE JSON FROM ~/sa-supabase-bq.json HERE> $$,
  'bigquery_sa_key',
  'GCP service account key for BigQuery FDW (read-only)'
);
```

Copy the returned UUID — you need it in step 5.

> ⚠️ Don't paste the JSON anywhere else. After this it lives encrypted
> in Vault; treat the on-disk copy as expendable and delete it
> (`shred -u ~/sa-supabase-bq.json` or just `rm`).

## 5. Apply the FDW DDL

Take `sql/supabase-fdw.sql` from this repo, replace the three
placeholders, and paste it into Supabase SQL Editor:

```bash
# Find your dataset's region (the FDW needs to know):
LOC=$(bq --project_id="$GCP_PROJECT_ID" show --format=prettyjson \
        "${GCP_PROJECT_ID}:${BQ_DATASET}" \
      | python3 -c "import json,sys; print(json.load(sys.stdin)['location'])")

sed \
  -e "s/__GCP_PROJECT_ID__/${GCP_PROJECT_ID}/g" \
  -e "s/__SA_KEY_ID__/<the-uuid-from-step-4>/g" \
  -e "s/__BQ_LOCATION__/${LOC}/g" \
  sql/supabase-fdw.sql | pbcopy           # macOS — paste into the SQL editor
```

The script:
- Creates the `bigquery_wrapper` foreign-data-wrapper handler
- Creates `bigquery_server` pointing at your dataset
- Creates `bq_health.{heart_rate,hrv,raw_metrics,workouts}_recent`
  foreign tables (each pointing at the matching BQ-side `*_recent_90d`
  view)
- Creates `public.*_recent` wrapper views — what PostgREST publishes as
  REST endpoints
- Grants USAGE / SELECT to the **`authenticated` role only**, and
  explicitly revokes from `anon`

## 6. Smoke-test it

In Supabase SQL Editor (this runs as your own DB user, so it bypasses
the role-based grants and just exercises the FDW):

```sql
SELECT COUNT(*) FROM public.heart_rate_recent;   -- should match BQ-side count
SELECT * FROM public.raw_metrics_recent
  WHERE metric_name = 'step_count'
  ORDER BY ts DESC LIMIT 5;
```

Confirm anon really can't see anything:

```sql
SELECT grantee, privilege_type, table_name
FROM information_schema.role_table_grants
WHERE table_schema = 'public'
  AND table_name LIKE '%_recent'
ORDER BY table_name, grantee;
-- Each table should show only `authenticated` — no `anon`.
```

## 7. Make a Supabase Auth user (for ChatGPT to sign into)

Supabase Dashboard → **Authentication → Users → Add user → Create new
user**. Use your own email + a strong password. Optionally enable
"Auto Confirm User" or confirm via the link.

This account is what ChatGPT will sign in as. The `authenticated` role
attached to its session is what unlocks the four `_recent` views.

## 8. ChatGPT's Supabase connector

In ChatGPT, add the Supabase connector. It will ask for either:

- **Email + password** (Supabase Auth login) — use the user from step 7.
  This is the recommended path: no long-lived secret leaves Supabase.
- **API key + project URL** — only if no login flow is offered. Use
  the **secret key** (`sb_secret_...`) from Settings → API. **Never use
  the publishable key here** — once we revoked anon access in step 5
  it's harmless on its own anyway, but the secret key is the only way
  to read.

### Custom instructions (required, not optional)

ChatGPT's connector enumerates `public` and reports `public tables: []`
even when the four `_recent` views exist — its introspection skips
foreign-backed views. You **must** name the views explicitly in the
chat or in Custom Instructions for the connector to find them.

Paste this block into ChatGPT's Custom Instructions (Settings →
Personalization → Custom Instructions, or the GPT's system prompt):

```
私の Supabase プロジェクトに BigQuery の Apple Health データへの
read facade があります。list_tables 系の自動探索には出てきません
(foreign table 経由のため)。直接 SQL で叩いてください。

利用可能な views (public schema, last 90 days):
- public.heart_rate_recent  (start_at, bpm, source, ingested_at)
- public.hrv_recent         (start_at, sdnn, source, ingested_at)
                            -- sdnn = HRV in ms
- public.raw_metrics_recent (metric_name, ts, value, unit, source,
                             ingested_at)
- public.workouts_recent    (start_at, end_at, activity_type,
                             duration_min, total_kcal, distance_km,
                             avg_hr, source, ingested_at)

raw_metrics_recent の代表的な metric_name:
  step_count, walking_running_distance, active_energy,
  basal_energy_burned, weight_body_mass, body_fat_percentage,
  resting_heart_rate, vo2_max, blood_oxygen_saturation,
  respiratory_rate, sleep_analysis, time_in_daylight,
  dietary_energy, protein, carbohydrates, total_fat, fiber, sodium

クエリの注意:
- timestamp は UTC。日次集計は DATE(ts AT TIME ZONE 'Asia/Tokyo') 等
  で JST に寄せる
- 90 日より古いデータは無い (recent view のため)
- 書き込みは不可 (read facade)
- 質問されたら list_tables ではなく直接 SELECT で投げる
```

If the connector ever loses the hint and reports "no tables", paste a
short reminder ("`public.hrv_recent` から SELECT して") into the chat
and it picks back up.

## 9. Adjust the recent-window length

The 90-day default is a balance between scan cost and "feels live". To
change it, edit the four BQ-side views in `sql/native-ddl.sql` and
re-apply that block (no Supabase change needed — the foreign tables
just see the new data through the same view name):

```sql
CREATE OR REPLACE VIEW `__PROJECT__.health.heart_rate_recent_90d` AS
SELECT * FROM `__PROJECT__.health.heart_rate`
WHERE DATE(start_at) >= DATE_SUB(CURRENT_DATE(), INTERVAL 180 DAY);
-- repeat for hrv / raw_metrics / workouts
```

(Keep the view names ending `_90d` even if the window changes; renaming
would force re-issuing the foreign-table DDL.)

## Cost notes

Every PostgREST call triggers a BQ query against the underlying view.
Because the view filter prunes partitions, scans stay bounded.
A `heart_rate_recent` query over 90 days reads on the order of 5–10 MB.
BigQuery's free tier is 1 TB/month — practically irrelevant for a
single user, but watch it if you wire up automated dashboards.

## Troubleshooting

| Symptom                                                                              | Fix                                                                                |
|--------------------------------------------------------------------------------------|------------------------------------------------------------------------------------|
| `Cannot query over table … without a filter on partition column` from the FDW       | The Supabase view is querying the base BQ table directly. Re-apply step 5; foreign tables must point at `*_recent_90d`, not the base table |
| `Permission denied: BigQuery`                                                        | SA missing `bigquery.jobUser` (project-level) or dataset-level READER              |
| Foreign table returns 0 rows but BQ has data                                         | `__BQ_LOCATION__` mismatch — set it to your dataset's region (e.g. `asia-northeast1`) |
| `permission denied for view heart_rate_recent` in ChatGPT                            | The user isn't logged into Supabase. Sign in via the connector's Auth flow         |
| ChatGPT 401 / 404 on a freshly added view                                            | PostgREST hasn't reloaded its schema. Database → API → "Reload schema"             |
| Want to revoke ChatGPT access immediately                                            | Authentication → Users → delete (or change password of) the connector's user       |
| Want to rotate the GCP key                                                           | Generate a new SA key, `vault.update_secret(<id>, …)` with the new JSON, no FDW change needed |
