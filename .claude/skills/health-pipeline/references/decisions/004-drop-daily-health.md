# ADR 004: Drop the `daily_health` rollup table

**Status:** Accepted

## Context

The first version maintained a `daily_health` table with pre-computed
per-day aggregates (steps, avg HR, avg SpO₂, weight, etc.) written by a
migration script. Intended as a cheap dashboard table.

Audit found:

- Three columns (`active_calories`, `sleep_hours`, plus one other) were
  100% NULL — the source data never populated them.
- Every other column was derivable on-demand from `raw_metrics` /
  `heart_rate` / `workouts` with a partition-filtered query costing
  kilobytes.
- Two writers (the receiver and the migration script) meant drift was
  possible and hard to detect.

## Decision

Drop `daily_health`. Derive all per-day views on demand from the four
time-series tables.

## Consequences

- **Good.** One less table to keep consistent. No duplicate-source
  ambiguity.
- **Good.** Every per-day slice becomes a SQL snippet in
  `query-patterns.md` — inspectable and tweakable per question.
- **Tradeoff.** Dashboard-style queries run slightly more SQL, but with
  partition pruning they're still sub-second and under free-tier cost.
- `archive/scripts/migrate-historical.ts` (which populated `daily_health`
  from a CSV) is kept for reference but marked deprecated at the top of
  the file. Do not run it.
