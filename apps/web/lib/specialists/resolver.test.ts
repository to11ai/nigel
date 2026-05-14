import { beforeEach, describe, expect, test } from "bun:test";
import { db } from "@/lib/db/client";
import { specialists } from "@/lib/db/schema";
import { nanoid } from "nanoid";
import { getSpecialist } from "./resolver";

beforeEach(async () => {
  await db.delete(specialists);
});

describe("getSpecialist", () => {
  test("returns the code preset when no override or custom row exists", async () => {
    const echo = await getSpecialist("echo");
    expect(echo).not.toBeNull();
    expect(echo?.name).toBe("echo");
    expect(echo?.kind).toBe("scripted");
    expect(echo?.script).toBeDefined();
  });

  test("override row merges partial fields onto the code preset", async () => {
    await db.insert(specialists).values({
      id: nanoid(),
      name: "echo",
      kind: "override",
      sandboxPolicy: "inherit",
      maxChildren: 7,
    });

    const echo = await getSpecialist("echo");
    expect(echo?.sandboxPolicy).toBe("inherit");
    expect(echo?.maxChildren).toBe(7);
    expect(echo?.mayRecurse).toBe(false);
    expect(echo?.script).toBeDefined();
  });

  test("custom row is returned for names not in PRESETS", async () => {
    await db.insert(specialists).values({
      id: nanoid(),
      name: "my-custom-role",
      kind: "custom",
      systemPrompt: "Be helpful.",
      model: "anthropic/claude-haiku-4.5",
      toolAllowlist: ["file", "search"],
      sandboxPolicy: "inherit",
      mayRecurse: false,
      maxChildren: 3,
      budgetUsdDefaultMicros: 1_000_000,
      needsLocalStack: false,
    });

    const role = await getSpecialist("my-custom-role");
    expect(role?.name).toBe("my-custom-role");
    expect(role?.kind).toBe("custom");
    expect(role?.systemPrompt).toBe("Be helpful.");
    expect(role?.toolAllowlist).toEqual(["file", "search"]);
    expect(role?.script).toBeUndefined();
  });

  test("returns null for an unknown name", async () => {
    const result = await getSpecialist("not-a-real-thing");
    expect(result).toBeNull();
  });

  test("rejects an override row with no matching code preset", async () => {
    await db.insert(specialists).values({
      id: nanoid(),
      name: "no-such-preset",
      kind: "override",
      sandboxPolicy: "fresh",
    });

    await expect(getSpecialist("no-such-preset")).rejects.toThrow(
      /override.*no matching preset/i,
    );
  });

  test("linter preset resolves with the expected shape", async () => {
    const linter = await getSpecialist("linter");
    expect(linter).not.toBeNull();
    expect(linter?.name).toBe("linter");
    expect(linter?.kind).toBe("preset");
    expect(linter?.systemPrompt).toContain("linter");
    expect(linter?.model).toBe("anthropic/claude-haiku-4.5");
    expect(linter?.toolAllowlist).toEqual(["file", "search", "shell"]);
    expect(linter?.sandboxPolicy).toBe("fresh");
    expect(linter?.mayRecurse).toBe(false);
    expect(linter?.maxChildren).toBe(0);
    expect(linter?.budgetUsdDefaultMicros).toBe(2_000_000);
    expect(linter?.needsLocalStack).toBe(false);
  });

  test("formatter preset resolves with the expected shape", async () => {
    const f = await getSpecialist("formatter");
    expect(f).not.toBeNull();
    expect(f?.name).toBe("formatter");
    expect(f?.kind).toBe("preset");
    expect(f?.systemPrompt).toContain("formatter");
    expect(f?.model).toBe("anthropic/claude-haiku-4.5");
    expect(f?.toolAllowlist).toEqual(["file", "search", "shell"]);
    expect(f?.sandboxPolicy).toBe("fresh");
    expect(f?.mayRecurse).toBe(false);
    expect(f?.maxChildren).toBe(0);
    expect(f?.budgetUsdDefaultMicros).toBe(2_000_000);
    expect(f?.needsLocalStack).toBe(false);
  });

  test("type-checker preset resolves with the expected shape", async () => {
    const tc = await getSpecialist("type-checker");
    expect(tc).not.toBeNull();
    expect(tc?.name).toBe("type-checker");
    expect(tc?.kind).toBe("preset");
    expect(tc?.systemPrompt).toContain("type-checker");
    expect(tc?.model).toBe("anthropic/claude-haiku-4.5");
    expect(tc?.toolAllowlist).toEqual(["file", "search", "shell"]);
    expect(tc?.sandboxPolicy).toBe("fresh");
    expect(tc?.mayRecurse).toBe(false);
    expect(tc?.maxChildren).toBe(0);
    expect(tc?.budgetUsdDefaultMicros).toBe(2_000_000);
    expect(tc?.needsLocalStack).toBe(false);
  });

  test("unit-tester preset resolves with the expected shape", async () => {
    const ut = await getSpecialist("unit-tester");
    expect(ut).not.toBeNull();
    expect(ut?.name).toBe("unit-tester");
    expect(ut?.kind).toBe("preset");
    expect(ut?.systemPrompt).toContain("unit-tester");
    expect(ut?.model).toBe("anthropic/claude-haiku-4.5");
    expect(ut?.toolAllowlist).toEqual(["file", "search", "shell"]);
    expect(ut?.sandboxPolicy).toBe("fresh");
    expect(ut?.mayRecurse).toBe(false);
    expect(ut?.maxChildren).toBe(0);
    expect(ut?.budgetUsdDefaultMicros).toBe(3_000_000);
    expect(ut?.needsLocalStack).toBe(false);
  });

  test("e2e-tester preset resolves with the expected shape", async () => {
    const e = await getSpecialist("e2e-tester");
    expect(e).not.toBeNull();
    expect(e?.name).toBe("e2e-tester");
    expect(e?.kind).toBe("preset");
    expect(e?.systemPrompt).toContain("e2e-tester");
    expect(e?.model).toBe("anthropic/claude-sonnet-4.6");
    expect(e?.toolAllowlist).toEqual(["file", "search", "shell"]);
    expect(e?.sandboxPolicy).toBe("fresh");
    expect(e?.mayRecurse).toBe(false);
    expect(e?.maxChildren).toBe(0);
    expect(e?.budgetUsdDefaultMicros).toBe(5_000_000);
    expect(e?.needsLocalStack).toBe(true);
  });

  test("reviewer preset resolves with the expected shape (read-only)", async () => {
    const rev = await getSpecialist("reviewer");
    expect(rev).not.toBeNull();
    expect(rev?.name).toBe("reviewer");
    expect(rev?.kind).toBe("preset");
    expect(rev?.systemPrompt).toContain("reviewer");
    expect(rev?.model).toBe("anthropic/claude-sonnet-4.6");
    // file_read (not file) — runtime enforces no-writes via the allowlist.
    expect(rev?.toolAllowlist).toEqual(["file_read", "search"]);
    expect(rev?.sandboxPolicy).toBe("fresh");
    expect(rev?.mayRecurse).toBe(false);
    expect(rev?.maxChildren).toBe(0);
    expect(rev?.budgetUsdDefaultMicros).toBe(5_000_000);
    expect(rev?.needsLocalStack).toBe(false);
  });

  test("adversarial-reviewer preset resolves with the expected shape", async () => {
    const adv = await getSpecialist("adversarial-reviewer");
    expect(adv).not.toBeNull();
    expect(adv?.name).toBe("adversarial-reviewer");
    expect(adv?.kind).toBe("preset");
    expect(adv?.systemPrompt).toContain("adversarial-reviewer");
    expect(adv?.model).toBe("anthropic/claude-opus-4.7");
    // Spec lists "shell (read-only)" but shell-readonly is its own
    // feature; deferred. file_read + search until then.
    expect(adv?.toolAllowlist).toEqual(["file_read", "search"]);
    expect(adv?.sandboxPolicy).toBe("fresh_clean");
    expect(adv?.mayRecurse).toBe(false);
    expect(adv?.maxChildren).toBe(0);
    expect(adv?.budgetUsdDefaultMicros).toBe(10_000_000);
    expect(adv?.needsLocalStack).toBe(false);
  });

  test("researcher preset resolves with the expected shape", async () => {
    const r = await getSpecialist("researcher");
    expect(r).not.toBeNull();
    expect(r?.name).toBe("researcher");
    expect(r?.kind).toBe("preset");
    expect(r?.systemPrompt).toContain("researcher");
    expect(r?.model).toBe("anthropic/claude-sonnet-4.6");
    // Phase G unblocked the recursive fan-out the spec originally
    // called for. Researcher now dispatches sub-researchers via
    // `dispatch_specialist` for independent sub-questions, with
    // runtime enforcement that only researchers can be dispatched
    // (prevents prompt-injected web content from escalating).
    expect(r?.toolAllowlist).toEqual([
      "web",
      "file_read",
      "search",
      "dispatch_specialist",
    ]);
    expect(r?.sandboxPolicy).toBe("inherit");
    expect(r?.mayRecurse).toBe(true);
    expect(r?.maxChildren).toBe(5);
    expect(r?.dispatchTargetAllowlist).toEqual(["researcher"]);
    expect(r?.budgetUsdDefaultMicros).toBe(4_000_000);
    expect(r?.needsLocalStack).toBe(false);
  });

  test("planner preset resolves with the expected shape", async () => {
    const p = await getSpecialist("planner");
    expect(p).not.toBeNull();
    expect(p?.name).toBe("planner");
    expect(p?.kind).toBe("preset");
    expect(p?.systemPrompt).toContain("planner");
    expect(p?.model).toBe("openai/gpt-5.5");
    // Coordinator-only surface per the spec amendment: no `file` /
    // `shell` / `git`. All code changes route through dispatched
    // worker specialists.
    expect(p?.toolAllowlist).toEqual([
      "file_read",
      "search",
      "web",
      "dispatch_specialist",
      "dispatch_specialists_parallel",
      "linear",
    ]);
    expect(p?.sandboxPolicy).toBe("inherit");
    expect(p?.mayRecurse).toBe(true);
    expect(p?.maxChildren).toBe(10);
    expect(p?.budgetUsdDefaultMicros).toBe(3_000_000);
    expect(p?.needsLocalStack).toBe(false);
  });

  test("data-analyst preset resolves with the expected shape", async () => {
    const d = await getSpecialist("data-analyst");
    expect(d).not.toBeNull();
    expect(d?.name).toBe("data-analyst");
    expect(d?.kind).toBe("preset");
    expect(d?.systemPrompt).toContain("data-analyst");
    expect(d?.model).toBe("anthropic/claude-sonnet-4.6");
    expect(d?.toolAllowlist).toEqual([
      "file_read",
      "search",
      "database_query",
      "clickhouse_query",
      "redis_command",
    ]);
    expect(d?.sandboxPolicy).toBe("fresh");
    expect(d?.mayRecurse).toBe(false);
    expect(d?.maxChildren).toBe(0);
    expect(d?.budgetUsdDefaultMicros).toBe(5_000_000);
    expect(d?.needsLocalStack).toBe(false);
  });

  test("pulumi-engineer preset resolves with the expected shape", async () => {
    const p = await getSpecialist("pulumi-engineer");
    expect(p).not.toBeNull();
    expect(p?.name).toBe("pulumi-engineer");
    expect(p?.kind).toBe("preset");
    expect(p?.systemPrompt).toContain("pulumi-engineer");
    expect(p?.model).toBe("anthropic/claude-sonnet-4.6");
    expect(p?.toolAllowlist).toEqual([
      "file",
      "search",
      "shell",
      "git",
      "mcp_call",
    ]);
    expect(p?.sandboxPolicy).toBe("inherit");
    expect(p?.mayRecurse).toBe(false);
    expect(p?.maxChildren).toBe(0);
    expect(p?.budgetUsdDefaultMicros).toBe(10_000_000);
    expect(p?.needsLocalStack).toBe(false);
  });

  test("linear-engineer preset resolves with the expected shape", async () => {
    const l = await getSpecialist("linear-engineer");
    expect(l).not.toBeNull();
    expect(l?.name).toBe("linear-engineer");
    expect(l?.kind).toBe("preset");
    expect(l?.systemPrompt).toContain("linear-engineer");
    // Verify the transition gate language is present so a future
    // edit can't accidentally remove the prompt-side safeguard.
    expect(l?.systemPrompt).toContain("may_transition: true");
    expect(l?.model).toBe("anthropic/claude-sonnet-4.6");
    expect(l?.toolAllowlist).toEqual([
      "file",
      "search",
      "shell",
      "git",
      "mcp_call",
    ]);
    expect(l?.sandboxPolicy).toBe("inherit");
    expect(l?.mayRecurse).toBe(false);
    expect(l?.maxChildren).toBe(0);
    expect(l?.budgetUsdDefaultMicros).toBe(5_000_000);
    expect(l?.needsLocalStack).toBe(false);
  });

  test("refuses planner override that re-adds 'file' to the allowlist", async () => {
    await db.insert(specialists).values({
      id: nanoid(),
      name: "planner",
      kind: "override",
      toolAllowlist: ["file_read", "search", "file"],
    });

    await expect(getSpecialist("planner")).rejects.toThrow(
      /planner_override_forbidden_tools/,
    );
  });

  test("refuses planner override that re-adds 'shell' to the allowlist", async () => {
    await db.insert(specialists).values({
      id: nanoid(),
      name: "planner",
      kind: "override",
      toolAllowlist: ["file_read", "search", "shell"],
    });

    await expect(getSpecialist("planner")).rejects.toThrow(
      /planner_override_forbidden_tools/,
    );
  });

  test("refuses planner override that re-adds 'git' to the allowlist", async () => {
    await db.insert(specialists).values({
      id: nanoid(),
      name: "planner",
      kind: "override",
      toolAllowlist: ["file_read", "search", "git"],
    });

    await expect(getSpecialist("planner")).rejects.toThrow(
      /planner_override_forbidden_tools/,
    );
  });

  test("planner override changing only budget (no toolAllowlist) succeeds", async () => {
    await db.insert(specialists).values({
      id: nanoid(),
      name: "planner",
      kind: "override",
      budgetUsdDefaultMicros: 1_500_000,
    });

    const p = await getSpecialist("planner");
    expect(p).not.toBeNull();
    expect(p?.name).toBe("planner");
    expect(p?.budgetUsdDefaultMicros).toBe(1_500_000);
    // Allowlist falls back to the preset's coordinator-only surface.
    expect(p?.toolAllowlist).toEqual([
      "file_read",
      "search",
      "web",
      "dispatch_specialist",
      "dispatch_specialists_parallel",
      "linear",
    ]);
  });

  test("planner override with only allowed allowlist entries succeeds", async () => {
    await db.insert(specialists).values({
      id: nanoid(),
      name: "planner",
      kind: "override",
      toolAllowlist: ["file_read", "search"],
    });

    const p = await getSpecialist("planner");
    expect(p).not.toBeNull();
    expect(p?.toolAllowlist).toEqual(["file_read", "search"]);
  });

  test("non-planner override adding 'file' to allowlist succeeds (guard is planner-specific)", async () => {
    await db.insert(specialists).values({
      id: nanoid(),
      name: "coder",
      kind: "override",
      toolAllowlist: ["file", "search", "shell", "git"],
    });

    const c = await getSpecialist("coder");
    expect(c).not.toBeNull();
    expect(c?.name).toBe("coder");
    expect(c?.toolAllowlist).toEqual(["file", "search", "shell", "git"]);
  });

  test("rejects a custom row missing required fields", async () => {
    await db.insert(specialists).values({
      id: nanoid(),
      name: "incomplete-custom",
      kind: "custom",
      // missing required fields like systemPrompt, model, etc.
    });

    await expect(getSpecialist("incomplete-custom")).rejects.toThrow(
      /custom.*incomplete/i,
    );
  });
});
