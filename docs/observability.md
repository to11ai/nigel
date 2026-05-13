# Observability

Nigel ships OpenTelemetry traces from the Next.js server runtime to Datadog. This document covers the trace structure, the attributes you can query on, the relevant Datadog setup, and common troubleshooting steps.

## Architecture

```
@vercel/otel (instrumentation.ts)
        │
        ├── auto-instruments fetch + http + Node fetch
        │
        ├── nigel.specialist tracer  → specialist.execute spans       (Phase 7b)
        │
        └── nigel.tool tracer        → tool.<name> spans              (Phase 7c)
                                       (parent = specialist.execute)
```

All exports go via OTLP/HTTP. The recommended Vercel + Datadog pattern is to point `OTEL_EXPORTER_OTLP_ENDPOINT` at the Datadog Agent's OTLP receiver and let the Agent forward to Datadog. The Datadog Vercel integration provisions the Agent.

## Trace structure

A typical specialist run produces a tree like this:

```
specialist.execute  (name=planner)
├── tool.dispatch_specialist [NB: no span — see below]
│   └── specialist.execute  (name=coder)
│       └── tool.database_query  (connection=appdb)
└── tool.slack_post  (connection=alerts)
```

- `specialist.execute` wraps `executeSpecialistViaLLM`. One per LLM-driven run (recursive dispatch produces a child `specialist.execute`).
- `tool.<name>` wraps each leaf tool callback (`database_query`, `clickhouse_query`, `redis_command`, `mcp_call`, `slack_post`). These attach to the surrounding `specialist.execute` via the active context — no manual propagation.
- `dispatch_specialist` is **not** wrapped in its own span. The child run it creates produces its own `specialist.execute` span, so adding a wrapper would be a redundant intermediate.

## Attribute reference

### `specialist.execute` spans

| Attribute | Type | Description |
|---|---|---|
| `nigel.specialist.name` | string | The specialist preset name (e.g. `planner`, `coder`, `data-analyst`). |
| `nigel.specialist.kind` | string | `preset` \| `override` \| `custom`. |
| `nigel.specialist.model` | string | Model ID, e.g. `anthropic/claude-sonnet-4.6`. Omitted when the specialist has no model. |
| `nigel.run.id` | string | The agent_runs row id. |
| `nigel.run.root_id` | string | Root of the run tree — useful for grouping all spans in one user-facing invocation. |
| `nigel.run.parent_id` | string | Parent run id (only set on non-root runs). |
| `nigel.run.depth` | number | Tree depth (0 for root). |
| `nigel.run.trigger_source` | string | `chat` \| `linear` \| `chained` \| `cron`. |
| `nigel.run.sandbox_policy` | string | `inherit` \| `fresh` \| `fresh_clean`. |
| `nigel.run.budget_micros` | number | Per-run budget cap (USD micros). |
| `nigel.run.cost_total_micros` | number | Aggregate cost across all steps. Set in `finally`, so it lands even on partial-run failures. |

Per-step events on the span (`specialist.step`):

| Field | Description |
|---|---|
| `step.input_tokens` | Prompt tokens for this step. |
| `step.output_tokens` | Completion tokens. |
| `step.cache_read_tokens` | Anthropic cache hits, when applicable. |
| `step.cost_micros` | Resolved per-step cost. Omitted when neither gateway-reported cost nor the local PRICING table could resolve a value. |

### `tool.*` spans

Common to all tool spans:

| Attribute | Description |
|---|---|
| `nigel.tool.name` | One of `database_query`, `clickhouse_query`, `redis_command`, `mcp_call`, `slack_post`. |
| `nigel.tool.specialist` | The dispatching specialist's name (for scope auditing). |
| `nigel.tool.connection` | The `tool_connections.name` being used. |
| `nigel.tool.error_code` | On failure: `connection_not_resolvable`, `scope_denied`, `wrong_kind`, `read_only_violation`, `transport_unsupported`, or `execution_failed`. Lets dashboards group failures without parsing exception messages. |

Per-tool:

| Tool | Additional attributes |
|---|---|
| `tool.database_query`, `tool.clickhouse_query` | `nigel.tool.sql_length`, `nigel.tool.row_limit` (when supplied). SQL text is not recorded — it can carry user data from the LLM's working memory. |
| `tool.redis_command` | `nigel.tool.command` (verb only — args are excluded for the same reason). |
| `tool.mcp_call` | `nigel.tool.operation` (`list_tools` \| `call_tool`); `nigel.tool.mcp_tool_name` on `call_tool`. |
| `tool.slack_post` | `nigel.tool.text_length`, `nigel.tool.has_blocks`. |

## Datadog setup

### Vercel deployment

1. Install the [Datadog Vercel integration](https://vercel.com/integrations/datadog) — this provisions the forwarding Agent and the Datadog API key.
2. Set Pulumi config (see `infra/vercel/index.ts`):
   - `otelExporterOtlpEndpoint` → the Agent's OTLP HTTP receiver (default `http://<agent-host>:4318`).
   - `otelExporterOtlpHeaders` → leave unset unless the Agent requires auth headers (the default Datadog Vercel integration does not).
   - `otelServiceName` → defaults to `nigel-web`; set per-stack if you want to distinguish prod / preview spans.
3. Deploy. The Agent forwards spans to Datadog under the configured service name.

### Local development

You generally don't want traces from local dev hitting Datadog. Leave `OTEL_EXPORTER_OTLP_ENDPOINT` unset; the SDK installs auto-instrumentation hooks (so the in-process span tree is correct) but drops exports.

If you do want to test end-to-end locally, run a Datadog Agent locally and point the env var at `http://localhost:4318`.

## Useful Datadog queries

Datadog APM uses its own query syntax. The queries below assume the `nigel-web` service.

- **Specialist runs by name** — `service:nigel-web operation_name:specialist.execute`, group by `@nigel.specialist.name`.
- **p95 specialist duration by specialist** — same filter, aggregate `p95(@duration)` grouped by `@nigel.specialist.name`.
- **Aggregate cost per root run** — `service:nigel-web operation_name:specialist.execute @nigel.run.depth:0`, sum `@nigel.run.cost_total_micros`.
- **Tool failure rate by tool + error_code** — `service:nigel-web operation_name:tool.*`, group by `@nigel.tool.name`, `@nigel.tool.error_code`. (Filter to error_code:* to exclude successes.)
- **Top connections by call volume** — `service:nigel-web operation_name:tool.*`, group by `@nigel.tool.connection`.
- **Scope denials over time** — `service:nigel-web @nigel.tool.error_code:scope_denied`. Spikes here indicate a planner / specialist trying to reach a tool_connection it shouldn't.

## Troubleshooting

**No spans arriving in Datadog.**

1. Confirm `OTEL_EXPORTER_OTLP_ENDPOINT` is set in the Vercel project's env vars for the deployment target (production vs preview).
2. Hit a route on the deployment, then check the Agent's logs for OTLP receive activity. The Datadog Vercel integration exposes Agent logs in its dashboard.
3. Verify the endpoint does **not** include `/v1/traces` — the OTLP HTTP exporter auto-suffixes it. A trailing `/v1/traces` produces a 404 silently.

**Spans arrive but missing the parent → child relationship.**

`@vercel/otel` must run on every Node-runtime invocation that produces spans. If you see orphan `tool.*` spans without a parent `specialist.execute`, check:

- `apps/web/instrumentation.ts` exports `register` (Next.js' hook).
- The route producing the spans is not Edge-runtime (Edge bypasses `instrumentation.ts`). Specialist execution is always Node.

**`nigel.run.cost_total_micros` is zero but step events show non-zero costs.**

This means the gateway / PRICING table didn't resolve a cost for any step. The events still record token counts. Update the PRICING table in `apps/web/lib/runs/cost.ts` if a model was recently added.

**Cost reported on the span doesn't match the DB rollup.**

The span attribute is recorded best-effort in `finally`; the DB write inside `addCostMicros` is also best-effort and logs on failure. If a step's DB write throws, the span has the cost but the DB rollup lags. Search Vercel logs for `[specialist-execution] addCostMicros failed for run` to find the run.

## File pointers

- `apps/web/instrumentation.ts` — `registerOTel()` server-side entry point.
- `apps/web/lib/runs/specialist-execution.ts` — `specialist.execute` span instrumentation.
- `apps/web/lib/observability/tool-span.ts` — shared `withToolSpan()` helper used by every tool callback.
- `apps/web/lib/runs/{database-query,clickhouse-query,redis-command,mcp-call,slack-post}.ts` — call sites for `withToolSpan`.
- `infra/vercel/index.ts` — Pulumi env-var wiring (`otelExporterOtlpEndpoint`, `otelExporterOtlpHeaders`, `otelServiceName`).
- `apps/web/.env.example` — Local-runtime env-var reference.
