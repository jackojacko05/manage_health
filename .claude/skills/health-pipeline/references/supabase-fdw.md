# Read BigQuery from Supabase via FDW

Goal: query the same `health` BigQuery dataset from Supabase/Postgres-aware
tools without duplicating data or running a sync job.

Approach: Supabase's `wrappers` extension exposes selected BigQuery Silver and
Gold objects as foreign tables in the Supabase `public` schema. Bronze/raw
BigQuery tables stay BigQuery-only. There are no active `_recent` or
`*_recent_90d` compatibility views.

Every caller must include the required date filter. If a Supabase FDW query
cannot push the filter down to BigQuery and BigQuery rejects it under
`require_partition_filter`, query through BigQuery MCP/CLI directly instead of
reintroducing bounded-window views.

Why not batch sync? See `decisions/006-supabase-fdw-over-sync.md`.

## Prereqs

- Working pipeline from `setup.md` with BigQuery dataset `health` populated.
- The BigQuery Silver/Gold views from `sql/native-ddl.sql`,
  `sql/sleep-ddl.sql`, and the Asken repo's `sql/asken-ddl.sql`.
- A Supabase project.
- `gcloud` and `bq` configured for the GCP project.

## 1. Create a read-only GCP service account

The FDW authenticates to BigQuery using a service account key. Keep it narrowly
scoped.

```bash
gcloud iam service-accounts create supabase-bq-reader \
  --project="$GCP_PROJECT_ID" \
  --display-name="Supabase BigQuery FDW reader"

SA="supabase-bq-reader@${GCP_PROJECT_ID}.iam.gserviceaccount.com"

gcloud projects add-iam-policy-binding "$GCP_PROJECT_ID" \
  --member="serviceAccount:${SA}" \
  --role="roles/bigquery.jobUser" --condition=None

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

gcloud iam service-accounts keys create ~/sa-supabase-bq.json \
  --iam-account="$SA" --project="$GCP_PROJECT_ID"
```

`bigquery.jobUser` lets the FDW run query jobs. Dataset-level `READER` reads
rows.

## 2. Enable Supabase extensions

In Supabase Dashboard -> Database -> Extensions, enable:

- `wrappers`
- `supabase_vault`

## 3. Store the service account key in Vault

In Supabase SQL Editor:

```sql
SELECT vault.create_secret(
  $$ <PASTE THE WHOLE JSON FROM ~/sa-supabase-bq.json HERE> $$,
  'bigquery_sa_key',
  'GCP service account key for BigQuery FDW (read-only)'
);
```

Copy the returned UUID. Delete the local JSON key after it is stored in Vault.

## 4. Apply the FDW DDL

Take `sql/supabase-fdw.sql`, replace the placeholders, and paste it into
Supabase SQL Editor:

```bash
LOC=$(bq --project_id="$GCP_PROJECT_ID" show --format=prettyjson \
        "${GCP_PROJECT_ID}:${BQ_DATASET}" \
      | python3 -c "import json,sys; print(json.load(sys.stdin)['location'])")

sed \
  -e "s/__GCP_PROJECT_ID__/${GCP_PROJECT_ID}/g" \
  -e "s/__SA_KEY_ID__/<the-uuid-from-step-3>/g" \
  -e "s/__BQ_LOCATION__/${LOC}/g" \
  sql/supabase-fdw.sql | pbcopy
```

The script rebuilds the FDW facade and grants SELECT only to the
`authenticated` role. It explicitly revokes SELECT from `anon`.

## Exposed Tables

Only BigQuery Silver/Gold objects are exposed through Supabase:

| Layer | Supabase table | BigQuery object | Required filter |
|---|---|---|---|
| Silver | `public.raw_metrics_dedup` | `health.raw_metrics_dedup` | `DATE(ts)` |
| Silver | `public.heart_rate_dedup` | `health.heart_rate_dedup` | `DATE(start_at)` |
| Silver | `public.hrv_dedup` | `health.hrv_dedup` | `DATE(start_at)` |
| Silver | `public.workouts_dedup` | `health.workouts_dedup` | `DATE(start_at)` |
| Silver | `public.sleep_daily_sources` | `health.sleep_daily_sources` | `sleep_date` |
| Silver | `public.asken_foods_effective` | `health.asken_foods_effective` | `date` |
| Silver | `public.asken_meals_effective` | `health.asken_meals_effective` | `date` |
| Gold | `public.sleep_daily` | `health.sleep_daily` | `sleep_date` |
| Gold | `public.hrv_regression_data` | `health.hrv_regression_data` | `date` |
| Gold | `public.hrv_regression_v2` | `health.hrv_regression_v2` | `date` |
| Gold | `public.hrv_seg_v3` | `health.hrv_seg_v3` | `date` |

## Smoke Test

Use bounded queries:

```sql
SELECT COUNT(*)
FROM public.heart_rate_dedup
WHERE DATE(start_at) BETWEEN DATE '2026-05-10' AND DATE '2026-05-17';

SELECT date, division, calories, protein_g, fat_g, carbs_g
FROM public.asken_meals_effective
WHERE date BETWEEN DATE '2026-05-10' AND DATE '2026-05-17'
ORDER BY date DESC, division;

SELECT sleep_date, sleep_hours, selected_source
FROM public.sleep_daily
WHERE sleep_date BETWEEN DATE '2026-05-10' AND DATE '2026-05-17'
ORDER BY sleep_date DESC;
```

Confirm no bounded-window leftovers:

```sql
SELECT n.nspname AS schema_name, c.relname AS object_name, c.relkind
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE c.relname LIKE '%recent%'
ORDER BY n.nspname, c.relname;
```

Expected result: no rows, except deliberately archived objects in non-runtime
schemas if you created any manually.

## Connector Notes

Some Supabase connectors do not list foreign tables through their table
discovery APIs. If discovery returns no tables, run SQL directly against the
`public.*` names listed above.

For stateless agents, keep this prompt fragment nearby:

```text
Supabase exposes BigQuery Silver/Gold health tables as public foreign tables.
Do not rely on table discovery. Query these names directly and always include
bounded date filters:

public.asken_foods_effective(date)
public.asken_meals_effective(date)
public.raw_metrics_dedup(DATE(ts))
public.heart_rate_dedup(DATE(start_at))
public.hrv_dedup(DATE(start_at))
public.workouts_dedup(DATE(start_at))
public.sleep_daily_sources(sleep_date)
public.sleep_daily(sleep_date)
public.hrv_regression_data(date)
public.hrv_regression_v2(date)
public.hrv_seg_v3(date)
```

For combined Asken + Apple Health examples, use the Asken repo's
`docs/supabase-analysis-guide.md` and `sql/supabase-golden-queries.sql`.

## Cost Notes

Every Supabase FDW query triggers a BigQuery query. Cost stays bounded only
when callers include the required date filters. BigQuery's free tier is still
generous for single-user health analysis, but unbounded exploratory queries are
blocked by `require_partition_filter` and should stay blocked.

## Troubleshooting

| Symptom | Fix |
|---|---|
| `Cannot query over table ... without a filter on partition column` | Add the required date filter in the query. If FDW still cannot push it down, use BigQuery MCP/CLI directly. |
| `Permission denied: BigQuery` | The service account is missing project-level `bigquery.jobUser` or dataset-level `READER`. |
| Foreign table returns 0 rows but BigQuery has data | Check the FDW `location` option matches the BigQuery dataset location. |
| Supabase table discovery says `public tables: []` | Query the `public.*` foreign table names directly; some discovery APIs skip foreign tables. |
| ChatGPT/Supabase connector gets permission errors | Sign in as a Supabase Auth user that maps to `authenticated`; `anon` is intentionally denied. |
| Want to revoke connector access immediately | Delete or disable the Supabase Auth user used by the connector. |
| Want to rotate the GCP key | Store a new key in Vault and re-apply `sql/supabase-fdw.sql` with the new Vault UUID. |
