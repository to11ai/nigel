import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  type Attributes,
  type AttributeValue,
  SpanStatusCode,
  trace,
} from "@opentelemetry/api";
import { startWebhookSpan } from "./webhook-span";

type CapturedSpan = {
  name: string;
  attributes: Attributes;
  status: { code: SpanStatusCode; message?: string } | null;
  exceptions: unknown[];
  ended: boolean;
};

function installFakeTracer(): { spans: CapturedSpan[]; restore: () => void } {
  const spans: CapturedSpan[] = [];
  const realGetTracer = trace.getTracer;
  trace.getTracer = (() =>
    ({
      startSpan(name: string, options?: { attributes?: Attributes }) {
        const captured: CapturedSpan = {
          name,
          attributes: { ...options?.attributes },
          status: null,
          exceptions: [],
          ended: false,
        };
        spans.push(captured);
        return {
          setAttribute(key: string, value: AttributeValue) {
            captured.attributes[key] = value;
            return this;
          },
          setStatus(s: { code: SpanStatusCode; message?: string }) {
            captured.status = s;
            return this;
          },
          recordException(err: unknown) {
            captured.exceptions.push(err);
            return this;
          },
          end() {
            captured.ended = true;
          },
        };
      },
    }) as unknown as ReturnType<
      typeof trace.getTracer
    >) as typeof trace.getTracer;
  return {
    spans,
    restore: () => {
      trace.getTracer = realGetTracer;
    },
  };
}

let captured: { spans: CapturedSpan[]; restore: () => void };

beforeEach(() => {
  captured = installFakeTracer();
});

afterEach(() => {
  captured.restore();
});

describe("startWebhookSpan", () => {
  test("emits a webhook.linear.intake span on finish", () => {
    const handle = startWebhookSpan({
      source: "linear",
      externalId: "delivery-abc",
    });
    handle.finish({
      outcomeKind: "run_created",
      runId: "run_new",
      outcomeReason: null,
      envelopeType: "Issue",
    });
    expect(captured.spans).toHaveLength(1);
    const span = captured.spans[0]!;
    expect(span.name).toBe("webhook.linear.intake");
    expect(span.attributes["nigel.webhook.source"]).toBe("linear");
    expect(span.attributes["nigel.webhook.external_id"]).toBe("delivery-abc");
    expect(span.attributes["nigel.webhook.envelope_type"]).toBe("Issue");
    expect(span.attributes["nigel.webhook.outcome"]).toBe("run_created");
    expect(span.attributes["nigel.run.id"]).toBe("run_new");
    expect(span.ended).toBe(true);
    expect(span.status).toBeNull();
  });

  test("marks error outcomes (signature_mismatch) as ERROR status", () => {
    const handle = startWebhookSpan({
      source: "linear",
      externalId: "delivery-bad",
    });
    handle.finish({
      outcomeKind: "signature_mismatch",
      runId: null,
      outcomeReason: null,
      envelopeType: null,
    });
    expect(captured.spans[0]?.status?.code).toBe(SpanStatusCode.ERROR);
    expect(captured.spans[0]?.status?.message).toBe("signature_mismatch");
  });

  test("does NOT mark idempotent outcomes (duplicate, ignored) as errors", () => {
    const dupHandle = startWebhookSpan({
      source: "linear",
      externalId: "d1",
    });
    dupHandle.finish({
      outcomeKind: "duplicate",
      runId: null,
      outcomeReason: null,
      envelopeType: "Issue",
    });
    const ignHandle = startWebhookSpan({
      source: "linear",
      externalId: "d2",
    });
    ignHandle.finish({
      outcomeKind: "ignored",
      runId: null,
      outcomeReason: "not an assignment-to-bot event",
      envelopeType: "Issue",
    });
    expect(captured.spans[0]?.status).toBeNull();
    expect(captured.spans[1]?.status).toBeNull();
    expect(captured.spans[1]?.attributes["nigel.webhook.outcome_reason"]).toBe(
      "not an assignment-to-bot event",
    );
  });

  test("fail() records exception and ends the span with ERROR status", () => {
    const handle = startWebhookSpan({
      source: "linear",
      externalId: "delivery-throw",
    });
    const err = new Error("workspace lookup failed");
    handle.fail(err);
    const span = captured.spans[0]!;
    expect(span.exceptions).toHaveLength(1);
    expect(span.status?.code).toBe(SpanStatusCode.ERROR);
    expect(span.status?.message).toBe("workspace lookup failed");
    expect(span.ended).toBe(true);
  });

  test("omits external_id and envelope_type when null", () => {
    const handle = startWebhookSpan({
      source: "linear",
      externalId: null,
    });
    handle.finish({
      outcomeKind: "invalid_payload",
      runId: null,
      outcomeReason: "no Linear-Delivery header and no event id in envelope",
      envelopeType: null,
    });
    expect(
      captured.spans[0]?.attributes["nigel.webhook.external_id"],
    ).toBeUndefined();
    expect(
      captured.spans[0]?.attributes["nigel.webhook.envelope_type"],
    ).toBeUndefined();
  });

  test("stamps envelope_type on finish for parsed Comment events", () => {
    const handle = startWebhookSpan({
      source: "linear",
      externalId: "delivery-cmd",
    });
    handle.finish({
      outcomeKind: "command",
      runId: null,
      outcomeReason: "transitioned",
      envelopeType: "Comment",
    });
    expect(captured.spans[0]?.attributes["nigel.webhook.envelope_type"]).toBe(
      "Comment",
    );
  });

  // Phase 7 L2: runInContext invokes the callback and propagates the
  // return value. We can't easily assert OTel context propagation
  // inside Bun's test process (no AsyncLocalStorage-based context
  // manager is registered by default), but we can verify the call
  // shape: the callback fires, errors bubble, the resolved value is
  // returned to the caller. Production runs under @vercel/otel which
  // installs the propagating context manager, so child spans really
  // do nest in real deployments.
  test("runInContext invokes the callback and resolves its value", async () => {
    const handle = startWebhookSpan({
      source: "linear",
      externalId: "delivery-ctx",
    });
    const result = await handle.runInContext(async () => 42);
    expect(result).toBe(42);
    handle.finish({
      outcomeKind: "ignored",
      runId: null,
      outcomeReason: null,
      envelopeType: "Issue",
    });
  });

  test("runInContext propagates throws", async () => {
    const handle = startWebhookSpan({
      source: "linear",
      externalId: "delivery-throw-ctx",
    });
    const err = new Error("boom");
    await expect(
      handle.runInContext(async () => {
        throw err;
      }),
    ).rejects.toBe(err);
    handle.fail(err);
  });
});
