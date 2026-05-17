# Setup: from zero to queryable health data

End-to-end steps to stand up the pipeline on your own GCP project. Assumes
`gcloud` is installed and authenticated, and you own an iPhone with
**Health Auto Export Pro** ("HAE Pro", paid) installed.

Rough time budget: **~30 minutes**, most of which is waiting on Cloud Run
build + first HAE sync.

## 0. Prerequisites

- macOS / Linux with `gcloud`, `bq`, `node >= 20`, `bash`
- A GCP project with billing enabled — note its **Project ID**
- iPhone with Apple Health data + HAE Pro

## 1. Configure env vars locally

```bash
cp assets/env.example .env
# edit .env:
#   GCP_PROJECT_ID=your-project-id
#   GCP_REGION=asia-northeast1        # or your preferred region
#   BQ_DATASET=health                 # leave as-is unless you want a different name
source .env
export GCP_PROJECT_ID GCP_REGION BQ_DATASET
```

## 2. Enable APIs + create dataset

```bash
gcloud services enable \
  run.googleapis.com \
  bigquery.googleapis.com \
  secretmanager.googleapis.com \
  --project="$GCP_PROJECT_ID"

bq --project_id="$GCP_PROJECT_ID" --location="$GCP_REGION" \
   mk -d "$BQ_DATASET"
```

## 3. Apply the table DDL

The DDL file uses `__PROJECT__` as a placeholder — substitute at apply time:

```bash
sed "s/__PROJECT__/${GCP_PROJECT_ID}/g" sql/native-ddl.sql \
  | bq query --project_id="$GCP_PROJECT_ID" --nouse_legacy_sql
```

Then enforce the partition filter on the four time-series tables:

```bash
for T in raw_metrics heart_rate hrv workouts; do
  bq query --project_id="$GCP_PROJECT_ID" --nouse_legacy_sql \
    "ALTER TABLE \`${GCP_PROJECT_ID}.${BQ_DATASET}.${T}\` \
     SET OPTIONS(require_partition_filter = TRUE)"
done
```

## 4. Create the shared auth token in Secret Manager

HAE Pro signs requests with an arbitrary token you choose. Generate one and
store it so Cloud Run can verify incoming requests:

```bash
openssl rand -hex 32 | gcloud secrets create hae-receiver-token \
  --project="$GCP_PROJECT_ID" --data-file=- --replication-policy=automatic

# Read it back — you will need it on the iPhone side (step 6).
gcloud secrets versions access latest \
  --secret=hae-receiver-token --project="$GCP_PROJECT_ID"
```

Grant the Cloud Run default compute service account access to the secret
and the dataset:

```bash
PROJECT_NUMBER=$(gcloud projects describe "$GCP_PROJECT_ID" --format='value(projectNumber)')
SA="${PROJECT_NUMBER}-compute@developer.gserviceaccount.com"

gcloud secrets add-iam-policy-binding hae-receiver-token \
  --project="$GCP_PROJECT_ID" \
  --member="serviceAccount:${SA}" \
  --role="roles/secretmanager.secretAccessor"

bq --project_id="$GCP_PROJECT_ID" \
   add-iam-policy-binding --member="serviceAccount:${SA}" \
   --role="roles/bigquery.dataEditor" \
   "${GCP_PROJECT_ID}:${BQ_DATASET}"
```

## 5. Deploy the receiver

```bash
cd hae-receiver
bash deploy.sh
# Prints the Service URL at the end — copy it.
```

## 6. Configure HAE Pro on the iPhone

See `hae-pro-config.md` for the detailed Automation setup. The short form:

- One Automation per table stream (metrics / heart rate / HRV / workouts)
- Destination: REST API, URL = the Cloud Run service URL from step 5
- Header: `X-Auth-Token: <the token from step 4>`
- Aggregation: **Hour** for metrics, **Seconds** for heart rate / HRV
- Schedule: Automatic (on background fetch) plus a Manual trigger you can tap

Tap the manual trigger once — within a minute you should see rows in
`raw_metrics`, `heart_rate`, and `hrv`.

## 7. (Optional) Backfill history from export.xml

See `backfill-from-xml.md`. One-time step, brings in years of Apple Health data.

## 8. Connect Claude

Two options — pick one (or both):

### 8a. Claude Code (local) via `.mcp.json`

```bash
cp .claude/skills/health-pipeline/assets/mcp.json.example .mcp.json
# Edit .mcp.json: replace <YOUR_GCP_PROJECT_ID> with your project id.
```

Restart Claude Code. The `bigquery` MCP server exposes `query`, `list_tables`,
etc. Try: *"What was my average resting HR last week?"* (partition-filtered —
see `query-patterns.md`).

### 8b. Claude.ai (remote) via custom connector

Google provides a fully-managed remote MCP at
`https://bigquery.googleapis.com/mcp` (Preview). Add it as a Custom Connector
in Claude.ai settings → complete the OAuth flow with the Google account that
has access to your project. Works from iPhone Claude as well.

## 9. Verify

```bash
bash .claude/skills/health-pipeline/scripts/verify.sh
```

Expected: non-zero row counts in all four time-series tables and a recent
`MAX(ts)` on `raw_metrics`.

## Asken

Asken ingestion is maintained separately in `../asken-sync`.
