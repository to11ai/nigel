import { describe, expect, test } from "bun:test";
import { isValidTransition, terminalStates } from "./state-machine";

describe("isValidTransition", () => {
  test("pending → running is valid", () => {
    expect(isValidTransition("pending", "running")).toBe(true);
  });

  test("running → completed is valid", () => {
    expect(isValidTransition("running", "completed")).toBe(true);
  });

  test("running → failed is valid", () => {
    expect(isValidTransition("running", "failed")).toBe(true);
  });

  test("running → blocked is valid", () => {
    expect(isValidTransition("running", "blocked")).toBe(true);
  });

  test("running → cancelled is valid", () => {
    expect(isValidTransition("running", "cancelled")).toBe(true);
  });

  test("running → awaiting_approval is valid", () => {
    expect(isValidTransition("running", "awaiting_approval")).toBe(true);
  });

  test("blocked → running is valid", () => {
    expect(isValidTransition("blocked", "running")).toBe(true);
  });

  test("blocked → cancelled is valid", () => {
    expect(isValidTransition("blocked", "cancelled")).toBe(true);
  });

  test("awaiting_approval → running is valid", () => {
    expect(isValidTransition("awaiting_approval", "running")).toBe(true);
  });

  test("awaiting_approval → cancelled is valid", () => {
    expect(isValidTransition("awaiting_approval", "cancelled")).toBe(true);
  });

  test("completed → running is invalid", () => {
    expect(isValidTransition("completed", "running")).toBe(false);
  });

  test("failed → running is invalid", () => {
    expect(isValidTransition("failed", "running")).toBe(false);
  });

  test("cancelled → running is invalid", () => {
    expect(isValidTransition("cancelled", "running")).toBe(false);
  });

  test("pending → completed (skipping running) is invalid", () => {
    expect(isValidTransition("pending", "completed")).toBe(false);
  });

  test("identity transitions (X → X) are invalid", () => {
    for (const s of [
      "pending",
      "running",
      "blocked",
      "awaiting_approval",
      "completed",
      "failed",
      "cancelled",
    ] as const) {
      expect(isValidTransition(s, s)).toBe(false);
    }
  });
});

describe("terminalStates", () => {
  test("contains exactly completed, failed, cancelled", () => {
    expect(terminalStates).toEqual(
      new Set(["completed", "failed", "cancelled"]),
    );
  });
});
