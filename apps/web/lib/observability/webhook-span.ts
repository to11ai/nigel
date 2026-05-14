import {
  type Attributes,
  context,
  SpanStatusCode,
  trace,
} from "@opentelemetry/api";

// Phase 7 L1: span helper for inbound webhook intake.
//
// The Linear (and future GitHub) webhook handler invokes this once
// per delivery so Datadog has a queryable surface for intake counts,
// outcomes, latency, and failure rates without needing the metrics
// SDK installed alongside the trace exporter.
//
// Unlike `withToolSpan`, this helper exposes the started span back
// to the caller so the caller can stamp the resolved outcome
// attributes (which aren't known until *after* the handler runs).
// Callers must always invoke `finishWebhookSpan` in a finally so the
// span ends even on unhandled throw.

// Resolved on each call rather than at module load so tests can
// install a fake tracer; see lifecycle-span.ts for the same pattern.
const TRACER_NAME = "nigel.webhook";

export type WebhookIntakeAttributes = {
  source: "linear" | "github";
  // The Linear-Delivery / GitHub X-Delivery header. Recorded so a
  // span can be cross-referenced with the corresponding row in
  // webhook_events when triaging a specific intake.
  externalId: string | null;
};

export type WebhookOutcomeAttributes = {
  // Mirrors WebhookHandlerOutcome's `kind` discriminator. We record
  // it as a flat string instead of the full union so adding new
  // outcomes doesn't require coordinating type changes here.
  outcomeKind: string;
  // The Run row id when the outcome created or transitioned one.
  // Lets a dashboard widget pivot from intake → run trace.
  runId: string | null;
  // Inner detail for failure-shaped outcomes. For Linear:
  //   unresolved_repo  → omit (no sub-classification)
  //   unresolved_owner → omit
  //   invalid_payload  → reason
  //   command          → outcome.kind of the inner CommandHandlerOutcome
  outcomeReason: string | null;
  // Resolved after JSON parsing succeeds, which is why it lands here
  // (in finish) rather than at start. Set to null when the payload
  // didn't parse — the span still records the failure.
  envelopeType: string | null;
};

export type WebhookSpanHandle = {
  // Phase 7 L2: run a function with the intake span as the active
  // OTel context. Any span created inside `fn` (or in any async task
  // it awaits) automatically nests under the intake span — that
  // includes auto-instrumented http/fetch client spans, manual spans
  // from the command handler / lifecycle dispatcher, and future
  // `withToolSpan` children. Without this wrapper the intake span
  // is started but is NEVER active — descendants would orphan.
  runInContext<T>(fn: () => Promise<T>): Promise<T>;
  finish(outcome: WebhookOutcomeAttributes): void;
  fail(err: unknown): void;
};

export function startWebhookSpan(
  attrs: WebhookIntakeAttributes,
): WebhookSpanHandle {
  const spanAttributes: Attributes = {
    "nigel.webhook.source": attrs.source,
  };
  if (attrs.externalId) {
    spanAttributes["nigel.webhook.external_id"] = attrs.externalId;
  }
  const span = trace
    .getTracer(TRACER_NAME)
    .startSpan(`webhook.${attrs.source}.intake`, {
      attributes: spanAttributes,
    });

  return {
    runInContext(fn) {
      // Read context.active() at call time, not span-creation time —
      // any baggage / parent context added between startWebhookSpan
      // and runInContext (e.g. by future middleware) needs to be
      // preserved alongside the intake span, not silently dropped.
      return context.with(trace.setSpan(context.active(), span), fn);
    },
    finish(outcome) {
      span.setAttribute("nigel.webhook.outcome", outcome.outcomeKind);
      if (outcome.runId) {
        span.setAttribute("nigel.run.id", outcome.runId);
      }
      if (outcome.outcomeReason) {
        span.setAttribute(
          "nigel.webhook.outcome_reason",
          outcome.outcomeReason,
        );
      }
      if (outcome.envelopeType) {
        span.setAttribute("nigel.webhook.envelope_type", outcome.envelopeType);
      }
      if (isErrorOutcome(outcome.outcomeKind)) {
        span.setStatus({
          code: SpanStatusCode.ERROR,
          message: outcome.outcomeKind,
        });
      }
      span.end();
    },
    fail(err) {
      span.recordException(err as Error);
      span.setStatus({
        code: SpanStatusCode.ERROR,
        message: err instanceof Error ? err.message : String(err),
      });
      span.end();
    },
  };
}

// Outcomes that should mark the span as ERROR in Datadog. These are
// caller-actionable failures, not idempotent no-ops:
//   - signature_mismatch: caller is sending a bad signature
//   - invalid_payload: caller sent a payload we can't parse
//   - no_workspace_configured: the integration isn't set up
//   - unresolved_repo / unresolved_owner: config drift
// `duplicate` and `ignored` are intentionally NOT errors — they're
// expected steady-state behavior.
const ERROR_OUTCOMES: ReadonlySet<string> = new Set([
  "signature_mismatch",
  "invalid_payload",
  "no_workspace_configured",
  "unresolved_repo",
  "unresolved_owner",
]);

function isErrorOutcome(kind: string): boolean {
  return ERROR_OUTCOMES.has(kind);
}
