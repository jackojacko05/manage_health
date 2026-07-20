# Public compatibility contract

This file describes what must remain stable while private extensions move out
of `manage_health`.

## Stable interfaces

- Environment names: `GCP_PROJECT_ID`, `GCP_REGION`, `BQ_DATASET`, and
  `BQ_LOCATION`
- Cloud Run receiver deployment from `hae-receiver/`
- BigQuery dataset placeholder shape `PROJECT_ID.health`
- Bronze/Silver/Gold table and view names documented in `AGENTS.md`
- required partition filters on time-series objects
- bounded query scripts under `scripts/`
- `scripts/apply-bigquery.sh all` rebuild order
- generic Supabase read facade for Silver/Gold objects

## Intentionally not stable/public

- personal project IDs, service URLs, account names, tokens, and IAM bindings
- OwnTracks and Google Places deployment details
- Asken and Fatigue tables
- private location semantics and Vault paths

## Compatibility test

Before moving a private extension, run the public receiver tests and a dry-run
of the BigQuery DDL with placeholder values. The extension must not change the
public table names, required filters, or the documented rebuild order.
