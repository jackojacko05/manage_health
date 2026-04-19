# ADR 003: Hourly aggregation for `raw_metrics`

**Status:** Accepted

## Context

HAE Pro can emit data at several aggregation levels: Seconds (raw), Minute,
Hour, Day, Week, Month. For HR and HRV we want per-sample granularity
(their value is in the variability), but for steps, energy, body mass,
respiratory rate, SpO₂, etc. the decision is: Seconds, Minute, or Hour?

- **Seconds**: preserves everything, but a full day is ~10k rows per
  metric → scan cost balloons for long queries, and the insight per extra
  row is marginal for a human-timescale question like "how are my steps
  trending".
- **Day**: cheap, but loses time-of-day pattern (circadian energy,
  afternoon slump in SpO₂, etc.).
- **Hour**: ~24 rows per metric per day, preserves time-of-day behaviour,
  still cheap.

## Decision

Use **Hour** aggregation for everything going into `raw_metrics` from both
live (HAE Pro Automation) and backfill (`migrate-from-export-xml.ts`'s
hour-bucket aggregator).

HR and HRV keep per-sample rows in their own dedicated tables.

## Consequences

- **Good.** `raw_metrics` stays small — ~300k rows for a decade of history.
- **Good.** Live and historical data share the same shape so `UNION`s are
  trivial.
- **Loss.** Sub-hour resolution for non-HR/HRV metrics. Rarely needed —
  and when it is, you can re-export from HealthKit.
- Cumulative metrics (steps, energy) use `SUM` within the hour;
  instantaneous metrics (weight, VO₂max, SpO₂) use `AVG`. The
  `SUM_METRICS` set in the backfill script enforces this split; HAE Pro
  does the right thing automatically with the Hour aggregation setting.
