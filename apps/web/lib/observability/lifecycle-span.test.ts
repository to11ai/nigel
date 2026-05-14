import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  type Attributes,
  type AttributeValue,
  SpanStatusCode,
  trace,
} from "@opentelemetry/api";
import { recordRunStatusChange } from "./lifecycle-span";

// Capture spans by stubbing trace.getTracer with a fake that records
// every started span. The real OTel SDK noops when not registered,
// so the test installs a global provider only for the duration of
// each test.

type CapturedSpan = {
  name: string;
  attributes: Attributes;
  status: { code: SpanStatusCode; message?: string } | null;
  ended: boolean;
};

function installFakeTracer(): {
  spans: CapturedSpan[];
  restore: () => void;
} {
  const spans: CapturedSpan[] = [];
  const realGetTracer = trace.getTracer;
  trace.getTracer = (() =>
    ({
      startSpan(name: string, options?: { attributes?: Attributes }) {
        const captured: CapturedSpan = {
          name,
          attributes: { ...options?.attributes },
          status: null,
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

describe("recordRunStatusChange", () => {
  test("emits a span with the core run + transition attributes", () => {
    recordRunStatusChange({
      runId: "run_1",
      rootRunId: "run_1",
      parentRunId: null,
      depth: 0,
      triggerSource: "linear",
      specialistId: "planner",
      from: "pending",
      to: "running",
      durationMs: null,
      costUsdMicros: 0,
      budgetUsdMicros: 5_000_000,
    });
    expect(captured.spans).toHaveLength(1);
    const span = captured.spans[0]!;
    expect(span.name).toBe("run.status_change");
    expect(span.ended).toBe(true);
    expect(span.attributes["nigel.run.id"]).toBe("run_1");
    expect(span.attributes["nigel.run.status.from"]).toBe("pending");
    expect(span.attributes["nigel.run.status.to"]).toBe("running");
    expect(span.attributes["nigel.run.trigger_source"]).toBe("linear");
    expect(span.attributes["nigel.specialist.name"]).toBe("planner");
    expect(span.attributes["nigel.run.budget_micros"]).toBe(5_000_000);
    // Non-terminal transition: no duration field.
    expect(span.attributes["nigel.run.duration_ms"]).toBeUndefined();
    // Non-error transition: no status set.
    expect(span.status).toBeNull();
  });

  test("includes parent_id on a child run", () => {
    recordRunStatusChange({
      runId: "run_child",
      rootRunId: "run_root",
      parentRunId: "run_parent",
      depth: 2,
      triggerSource: "chained",
      specialistId: "coder",
      from: "pending",
      to: "running",
      durationMs: null,
      costUsdMicros: 0,
      budgetUsdMicros: 5_000_000,
    });
    expect(captured.spans[0]?.attributes["nigel.run.parent_id"]).toBe(
      "run_parent",
    );
    expect(captured.spans[0]?.attributes["nigel.run.root_id"]).toBe("run_root");
    expect(captured.spans[0]?.attributes["nigel.run.depth"]).toBe(2);
  });

  test("records duration on terminal transitions", () => {
    recordRunStatusChange({
      runId: "run_done",
      rootRunId: "run_done",
      parentRunId: null,
      depth: 0,
      triggerSource: "linear",
      specialistId: "planner",
      from: "running",
      to: "completed",
      durationMs: 4321,
      costUsdMicros: 1_234_567,
      budgetUsdMicros: 5_000_000,
    });
    expect(captured.spans[0]?.attributes["nigel.run.duration_ms"]).toBe(4321);
    expect(captured.spans[0]?.attributes["nigel.run.cost_total_micros"]).toBe(
      1_234_567,
    );
  });

  test("marks failed transition as ERROR status", () => {
    recordRunStatusChange({
      runId: "run_fail",
      rootRunId: "run_fail",
      parentRunId: null,
      depth: 0,
      triggerSource: "linear",
      specialistId: "planner",
      from: "running",
      to: "failed",
      durationMs: 1000,
      costUsdMicros: 0,
      budgetUsdMicros: 5_000_000,
    });
    expect(captured.spans[0]?.status?.code).toBe(SpanStatusCode.ERROR);
    expect(captured.spans[0]?.status?.message).toBe("failed");
  });

  test("marks cancelled transition as ERROR status", () => {
    recordRunStatusChange({
      runId: "run_cancel",
      rootRunId: "run_cancel",
      parentRunId: null,
      depth: 0,
      triggerSource: "linear",
      specialistId: "planner",
      from: "running",
      to: "cancelled",
      durationMs: 500,
      costUsdMicros: 0,
      budgetUsdMicros: 5_000_000,
    });
    expect(captured.spans[0]?.status?.code).toBe(SpanStatusCode.ERROR);
  });

  test("does NOT set error status on completed", () => {
    recordRunStatusChange({
      runId: "run_ok",
      rootRunId: "run_ok",
      parentRunId: null,
      depth: 0,
      triggerSource: "linear",
      specialistId: "planner",
      from: "running",
      to: "completed",
      durationMs: 1000,
      costUsdMicros: 0,
      budgetUsdMicros: 5_000_000,
    });
    expect(captured.spans[0]?.status).toBeNull();
  });

  test("omits specialist attribute when null (chat-driven root run)", () => {
    recordRunStatusChange({
      runId: "run_chat",
      rootRunId: "run_chat",
      parentRunId: null,
      depth: 0,
      triggerSource: "chat",
      specialistId: null,
      from: "pending",
      to: "running",
      durationMs: null,
      costUsdMicros: 0,
      budgetUsdMicros: 5_000_000,
    });
    expect(
      captured.spans[0]?.attributes["nigel.specialist.name"],
    ).toBeUndefined();
  });
});
