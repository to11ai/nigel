import { type Attributes, SpanStatusCode, trace } from "@opentelemetry/api";

// Phase 7c: helper that wraps a tool-callback body in an OTel child
// span. The parent context is the `specialist.execute` span installed
// by Phase 7b; `startActiveSpan` reads that context implicitly so
// callers don't pass anything around.
//
// Each leaf tool callback wraps its body once. The shared helper
// keeps span lifecycle (try/catch/finally + setStatus +
// recordException) in one place so the call sites only carry the
// per-tool attribute bag.

const tracer = trace.getTracer("nigel.tool");

// Errors thrown by tool callbacks expose a `code` discriminant
// (`connection_not_resolvable`, `scope_denied`, `wrong_kind`,
// `read_only_violation`, `transport_unsupported`, `execution_failed`).
// We surface it as a span attribute so dashboards can count failures
// by cause without parsing exception messages.
function errorCode(err: unknown): string | undefined {
  if (err && typeof err === "object" && "code" in err) {
    const value = (err as { code: unknown }).code;
    return typeof value === "string" ? value : undefined;
  }
  return undefined;
}

export async function withToolSpan<T>(
  spanName: string,
  attributes: Attributes,
  fn: () => Promise<T>,
): Promise<T> {
  return tracer.startActiveSpan(
    spanName,
    { attributes },
    async (span): Promise<T> => {
      try {
        return await fn();
      } catch (err) {
        const code = errorCode(err);
        if (code !== undefined) {
          span.setAttribute("nigel.tool.error_code", code);
        }
        span.recordException(err as Error);
        span.setStatus({
          code: SpanStatusCode.ERROR,
          message: err instanceof Error ? err.message : String(err),
        });
        throw err;
      } finally {
        span.end();
      }
    },
  );
}
