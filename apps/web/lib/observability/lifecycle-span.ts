import { type Attributes, SpanStatusCode, trace } from "@opentelemetry/api";
import type { RunStatus } from "@/lib/runs/state-machine";

// Phase 7 L1: emit a thin OTel span on every run-status change.
//
// Why a span and not a metric? The existing OTel pipeline only ships
// traces (see instrumentation.ts); Datadog APM derives count/p95/p99
// aggregates from spans automatically, so a span here lights up the
// usual `operation_name:run.status_change` query surface without
// adding the metrics SDK as a dependency.
//
// The span has no body — it represents an instantaneous transition,
// not a wrapped operation. It's recorded inside `updateRunStatus`
// *after* the DB write succeeds; recording before would log
// transitions that never persisted on a write error.

// Resolved inside `recordRunStatusChange` rather than at module
// load so tests can install a fake tracer via `trace.getTracer =`
// without racing against import-time evaluation.
const TRACER_NAME = "nigel.run";

export type RunStatusChangeAttributes = {
  runId: string;
  rootRunId: string;
  parentRunId: string | null;
  depth: number;
  triggerSource: string;
  specialistId: string | null;
  from: RunStatus;
  to: RunStatus;
  // Wall-clock duration between `startedAt` and `endedAt`. Only set
  // when the transition is terminal (completed/failed/cancelled);
  // null on intermediate transitions because the run is still
  // running and there's no meaningful duration yet.
  durationMs: number | null;
  // The accumulated cost rolled up onto the run row at transition
  // time. Useful to compare against the budget cap on terminal
  // transitions, and to spot runaway accruals on intermediate ones.
  costUsdMicros: number;
  // Per-run budget cap so Datadog can compute (cost / budget) ratios
  // directly from span attributes without joining tables.
  budgetUsdMicros: number;
};

export function recordRunStatusChange(attrs: RunStatusChangeAttributes): void {
  const spanAttributes: Attributes = {
    "nigel.run.id": attrs.runId,
    "nigel.run.root_id": attrs.rootRunId,
    "nigel.run.depth": attrs.depth,
    "nigel.run.trigger_source": attrs.triggerSource,
    "nigel.run.status.from": attrs.from,
    "nigel.run.status.to": attrs.to,
    "nigel.run.cost_total_micros": attrs.costUsdMicros,
    "nigel.run.budget_micros": attrs.budgetUsdMicros,
  };
  if (attrs.parentRunId) {
    spanAttributes["nigel.run.parent_id"] = attrs.parentRunId;
  }
  if (attrs.specialistId) {
    spanAttributes["nigel.specialist.name"] = attrs.specialistId;
  }
  if (attrs.durationMs !== null) {
    spanAttributes["nigel.run.duration_ms"] = attrs.durationMs;
  }
  const span = trace.getTracer(TRACER_NAME).startSpan("run.status_change", {
    attributes: spanAttributes,
  });
  // Failed/cancelled transitions set the span to ERROR so Datadog's
  // default error-rate widgets pick them up without a custom filter.
  if (attrs.to === "failed" || attrs.to === "cancelled") {
    span.setStatus({ code: SpanStatusCode.ERROR, message: attrs.to });
  }
  span.end();
}
