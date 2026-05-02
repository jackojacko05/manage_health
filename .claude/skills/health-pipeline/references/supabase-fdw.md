# Read BigQuery from Supabase (and ChatGPT) via FDW

Goal: query the same `health` BigQuery dataset from Supabase's PostgREST
API — primarily so external Postgres-aware tools (e.g. **ChatGPT's
Supabase connector**) can hit it without any data duplication or sync
job.

Approach: Supabase's `wrappers` extension provides a **BigQuery Foreign
Data Wrapper (FDW)**. Foreign tables in Supabase point at BQ tables;
queries are pushed down to BQ at read time. We layer **`*_recent`
views** and **`*_in_range` RPC functions** in `public` so callers always
hit a partition-pruning shape.

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

for ROLE in roles/bigquery.dataViewer roles/bigquery.jobUser; do
  gcloud projects add-iam-policy-binding "$GCP_PROJECT_ID" \
    --member="serviceAccount:${SA}" --role="$ROLE"
done

# Limit the data-access role to the health dataset only (recommended).
bq --project_id="$GCP_PROJECT_ID" \
   add-iam-policy-binding --member="serviceAccount:${SA}" \
   --role="roles/bigquery.dataViewer" \
   "${GCP_PROJECT_ID}:${BQ_DATASET}"

# Generate the JSON key — copy it; you'll paste it into Supabase Vault.
gcloud iam service-accounts keys create ~/sa-supabase-bq.json \
  --iam-account="$SA" --project="$GCP_PROJECT_ID"
```

`bigquery.jobUser` lets the FDW run query jobs (project-level role).
`bigquery.dataViewer` is what reads rows; scope it to the dataset for
least privilege.

## 2. Enable extensions in Supabase

In Supabase Dashboard → **Database → Extensions**, enable:

- `wrappers` (the FDW host)
- `supabase_vault` (usually already on)

## 3. Store the SA key in Vault

In Supabase **SQL Editor**:

```sql
SELECT vault.create_secret(
  $$ <PASTE THE WHOLE JSON FROM ~/sa-supabase-bq.json HERE> $$,
  'bigquery_sa_key',
  'GCP service account key for BigQuery FDW (read-only)'
);
```

Copy the returned UUID — you need it in step 4.

> ⚠️ Don't paste the JSON anywhere else. After this it lives encrypted
> in Vault; treat the on-disk copy as expendable and delete it
> (`shred -u ~/sa-supabase-bq.json` or just `rm`).

## 4. Apply the FDW DDL

Take `sql/supabase-fdw.sql` from this repo, replace the two placeholders,
and paste it into Supabase SQL Editor:

```bash
sed \
  -e "s/__GCP_PROJECT_ID__/${GCP_PROJECT_ID}/g" \
  -e "s/__SA_KEY_ID__/<the-uuid-from-step-3>/g" \
  sql/supabase-fdw.sql | pbcopy           # macOS — paste into the SQL editor
```

The script:
- Creates `bigquery_wrapper` foreign-data-wrapper handler
- Creates `bigquery_server` pointing at your dataset
- Creates `bq_health.{raw_metrics,heart_rate,hrv,workouts}` foreign tables
- Creates `public.*_recent` views (last 90 days, default for casual reads)
- Creates `public.*_in_range(start_date, end_date)` RPC functions for
  arbitrary ranges
- Grants SELECT / EXECUTE to the `anon` and `authenticated` roles

> **`location` option**: every foreign table sets `location 'US'`. If
> your dataset isn't in the US multi-region, change it to match (e.g.
> `asia-northeast1` for Tokyo). Check with:
> `bq --project_id=$GCP_PROJECT_ID show $BQ_DATASET | grep Location`.

## 5. Smoke-test it

In Supabase SQL Editor:

```sql
SELECT COUNT(*) FROM public.heart_rate_recent;             -- last 90d
SELECT * FROM public.raw_metrics_in_range(
  '2025-04-01'::date, '2025-04-07'::date, 'step_count');
```

If you see `Cannot query over table … without a filter on partition
column`, the view's date filter wasn't pushed down. Workarounds:
1. Replace the `CURRENT_DATE - INTERVAL '90 days'` in the view with a
   literal date (`'2025-01-01'::timestamp`) and rotate it periodically.
2. Use the RPC functions instead (always require explicit dates).

## 6. ChatGPT's Supabase connector

Add the connector in ChatGPT's settings using:

- **Project URL**: `https://<project-ref>.supabase.co`
- **Anon public key**: from Supabase Dashboard → Settings → API

ChatGPT will then have read access to:
- `public.raw_metrics_recent` (and the other three `_recent` views) via
  `GET /rest/v1/raw_metrics_recent?…`
- The four `*_in_range` RPCs via `POST /rest/v1/rpc/raw_metrics_in_range`

Tell the model in your custom instructions which views to use:

> When asked about my health, query the `*_recent` views for the last
> ~90 days. For older history, call the `*_in_range` RPC functions with
> explicit `start_date` / `end_date`. Never expect tables outside
> `public` to be readable.

## 7. Adjust the recent-window length

The 90-day default is a balance between scan cost and "feels live". To
change it, edit the four views in `sql/supabase-fdw.sql` and re-apply
just that block:

```sql
CREATE OR REPLACE VIEW public.raw_metrics_recent AS
SELECT * FROM bq_health.raw_metrics
WHERE ts >= (CURRENT_DATE - INTERVAL '180 days')::timestamp;
-- repeat for heart_rate / hrv / workouts
```

## Cost notes

Every PostgREST/RPC call triggers a BQ query. Because
`require_partition_filter = TRUE` is on the underlying tables and every
exposed view/RPC carries a date predicate, scans stay bounded.
A `_recent` view query over 90 days of `raw_metrics` reads on the order
of 5–10 MB. BigQuery's free tier is 1 TB/month — practically irrelevant
for a single user, but watch it if you add automated dashboards.

## Troubleshooting

| Symptom                                                  | Fix                                                                    |
|----------------------------------------------------------|------------------------------------------------------------------------|
| `Cannot query over table … without a filter on partition column` | Use the view or an RPC; or pin a literal date in the view (see step 5) |
| `Permission denied: BigQuery` from Supabase             | SA missing `bigquery.jobUser` (project-level) or dataset-level viewer  |
| Foreign table returns 0 rows but BQ has data           | `location` mismatch — set it to your dataset's region                  |
| ChatGPT 401 / 404                                       | Wrong anon key, or PostgREST hasn't picked up the new view (refresh: Database → Roles → reload schema) |
| Want to revoke ChatGPT access                           | Settings → API → **Reset anon key**                                    |
