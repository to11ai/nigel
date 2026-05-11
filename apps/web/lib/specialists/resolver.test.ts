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
    // Spec lists may_recurse=true + dispatch_specialist tool, both
    // deferred until the dispatch_specialist tool ships. Until then
    // researcher is non-recursive: web + file_read + search only.
    expect(r?.toolAllowlist).toEqual(["web", "file_read", "search"]);
    expect(r?.sandboxPolicy).toBe("inherit");
    expect(r?.mayRecurse).toBe(false);
    expect(r?.maxChildren).toBe(0);
    expect(r?.budgetUsdDefaultMicros).toBe(4_000_000);
    expect(r?.needsLocalStack).toBe(false);
  });

  test("planner preset resolves with the expected shape", async () => {
    const p = await getSpecialist("planner");
    expect(p).not.toBeNull();
    expect(p?.name).toBe("planner");
    expect(p?.kind).toBe("preset");
    expect(p?.systemPrompt).toContain("planner");
    expect(p?.model).toBe("anthropic/claude-sonnet-4.6");
    expect(p?.toolAllowlist).toEqual([
      "file",
      "search",
      "shell",
      "git",
      "web",
      "dispatch_specialist",
    ]);
    expect(p?.sandboxPolicy).toBe("inherit");
    expect(p?.mayRecurse).toBe(true);
    expect(p?.maxChildren).toBe(10);
    expect(p?.budgetUsdDefaultMicros).toBe(10_000_000);
    expect(p?.needsLocalStack).toBe(false);
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
