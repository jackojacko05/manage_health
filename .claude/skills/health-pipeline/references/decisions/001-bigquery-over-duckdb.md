# ADR 001: BigQuery over DuckDB

**Status:** Accepted

## Context

First prototype used DuckDB with a local Parquet file as the warehouse.
Queries were fast and free, but:

- No way for Claude to reach the data from a phone or a remote session —
  the database only existed on one laptop.
- Cloud Run → DuckDB would need a persistent disk and a custom sync loop.
- There's no official MCP for DuckDB-as-a-service.

## Decision

Use BigQuery as the single source of truth.

## Consequences

- **Good.** Fully managed, cheap at this volume (< 100 MB total → queries
  essentially free), officially supported MCP servers (both a local
  Claude Code MCP and Google's managed remote MCP at
  `https://bigquery.googleapis.com/mcp`).
- **Good.** Claude can query from iPhone Claude, laptop Claude Code, or
  Claude.ai web — all hit the same data.
- **Cost risk** mitigated by `require_partition_filter = TRUE` on every
  time-series table (see ADR 003).
- **Tradeoff.** Slightly higher round-trip latency than local DuckDB, but
  for interactive single-user analysis it's imperceptible.
