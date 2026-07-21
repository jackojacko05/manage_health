# Public scope

`manage_health` remains a public repository and the implementation linked from
the Zenn article:

<https://zenn.dev/jackojacko05/articles/58e0d632be419a>

The public contract is the reproducible, project-agnostic Apple Health
pipeline:

```text
Health Auto Export Pro
  -> generic Cloud Run receiver
  -> BigQuery Bronze/Silver/Gold
  -> bounded BigQuery MCP or Supabase read facade
```

## Public core

- HAE payload parsing and generic receiver behavior
- `raw_metrics`, `heart_rate`, `hrv`, `workouts`, and sleep schemas
- Bronze/Silver/Gold normalization and bounded queries
- partition-filter requirements
- `export.xml` streaming backfill guidance
- generic GCS backup/restore guidance
- generic BigQuery MCP and Supabase read-facade guidance
- placeholder-only environment and Secret Manager instructions
- tests and documentation that work in a user's own GCP project

The public code must not depend on the author's project, service URL, account,
token, personal health export, or private Vault.

## Private extensions

These features are candidates for the separate private
`personal-health-platform` repository:

- Asken credentials, scraper, and meal data
- personal location events, places, and Google Places enrichment
- personal Fatigue API and iOS client
- private deployment overlays and account-specific IAM
- raw exports, private URLs, and operational credentials

The current receiver still contains an OwnTracks route and is therefore a
mixed implementation. It must be split before a strict public release; the
verification script reports this as a blocker instead of silently treating it
as public.

## Release rule

Run `scripts/verify-public-release.sh` in report mode during development and
`scripts/verify-public-release.sh --strict` only after the private extension
split. A strict release must pass the repository tests and the public-scope
secret/personal-data checks.
