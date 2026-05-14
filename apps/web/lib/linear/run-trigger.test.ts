import { describe, expect, test } from "bun:test";
import { buildTaskText } from "./run-trigger";

const ISSUE = {
  identifier: "PLAT-42",
  title: "Audit auth middleware",
  description: "We saw 401s in prod. Check session-token storage.",
  url: "https://linear.app/to11/issue/PLAT-42",
};

describe("buildTaskText", () => {
  test("includes the identifier, title, source url, and body", () => {
    const text = buildTaskText(ISSUE);
    expect(text).toContain("PLAT-42 — Audit auth middleware");
    expect(text).toContain("https://linear.app/to11/issue/PLAT-42");
    expect(text).toContain("We saw 401s in prod.");
  });

  test("falls back to a placeholder when description is empty", () => {
    const text = buildTaskText({ ...ISSUE, description: "" });
    expect(text).toContain("(no description on the ticket)");
  });

  test("omits a source line when url is absent", () => {
    const { url: _omit, ...issueNoUrl } = ISSUE;
    const text = buildTaskText(issueNoUrl);
    expect(text).not.toContain("Source:");
  });

  test("appends the AgentSession prompt under a dedicated header", () => {
    const text = buildTaskText(ISSUE, "focus on the auth module");
    expect(text).toContain("User instructions (from Linear session panel):");
    expect(text).toContain("focus on the auth module");
    // Prompt comes AFTER the ticket body so the planner sees
    // ticket context first, then the live user instruction.
    const promptIdx = text.indexOf("focus on the auth module");
    const bodyIdx = text.indexOf("We saw 401s in prod.");
    expect(promptIdx).toBeGreaterThan(bodyIdx);
  });

  test("ignores a whitespace-only prompt", () => {
    const text = buildTaskText(ISSUE, "   \n\t  ");
    expect(text).not.toContain("User instructions");
  });

  test("ignores null/undefined prompt (assignment-only path)", () => {
    const a = buildTaskText(ISSUE, null);
    const b = buildTaskText(ISSUE, undefined);
    expect(a).toBe(b);
    expect(a).not.toContain("User instructions");
  });
});
