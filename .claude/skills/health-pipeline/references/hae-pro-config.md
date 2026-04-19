# HAE Pro iPhone-side configuration

**Health Auto Export Pro** (the paid tier; free tier has no Automations) is
what makes the phone push data on its own — no shortcuts, no manual taps.

App: https://www.healthexportapp.com/

## Concept

HAE Pro has **Automations** that fire on a schedule (or on background
fetch) and POST a JSON payload to a URL you specify. You set up one
Automation per "stream" so you can tune aggregation and cadence per table.

## Required global settings

- **Settings → API → REST API**: enabled
- **Settings → Aggregate Data**: leave default (per-Automation override
  below is what matters)
- **Background App Refresh** (iOS Settings → HAE): **on**

## Automations

Create four. For every one of them:

- Destination: **REST API**
- URL: the Cloud Run service URL printed by `deploy.sh`
- Method: `POST`
- Headers: `X-Auth-Token: <token you put in Secret Manager>`
- Format: **JSON**

### 1. Metrics (hourly)

- Data → Health Metrics: select everything you care about (steps, energy,
  body mass, SpO₂, respiratory rate, sleep, etc.)
- **Aggregate: Hour**  ← keeps scan cost low; see
  `decisions/003-hourly-granularity.md`
- Schedule: **Automatic** (background fetch) + keep the manual trigger
- Lookback: 1 day

### 2. Heart rate (per-sample)

- Data → Health Metrics: **Heart Rate** only
- **Aggregate: Seconds** (i.e. raw samples)
- Same schedule

### 3. HRV (per-sample)

- Data → Health Metrics: **Heart Rate Variability** only
- **Aggregate: Seconds**

### 4. Workouts

- Data → Workouts: enabled
- Include route / heart-rate summary if you want the aggregates rich
- Schedule: Automatic

## Verifying end-to-end

1. Open HAE Pro, tap the manual trigger on the metrics Automation
2. Watch the Cloud Run logs:
   ```bash
   gcloud run services logs read hae-receiver \
     --project="$GCP_PROJECT_ID" --region="$GCP_REGION" --limit=50
   ```
   You should see `POST /` with a 200 response.
3. Query BigQuery:
   ```sql
   SELECT metric_name, COUNT(*), MAX(ts)
   FROM `PROJECT.health.raw_metrics`
   WHERE DATE(ts) >= CURRENT_DATE() - 1
   GROUP BY 1 ORDER BY 1;
   ```

## Troubleshooting

| Symptom                          | Likely cause                                         |
|----------------------------------|------------------------------------------------------|
| 401 in logs                      | Token mismatch — regenerate secret, update HAE header |
| 200 but no rows                  | Empty payload (no samples since last run). Widen lookback or wait. |
| iPhone Automation never fires    | Background App Refresh off, or HAE not launched recently |
| `metric_name` you expected missing | HAE didn't include it — toggle it in the Automation's metric selector |

If you want to add or remove metrics, see `customize-metrics.md`.
