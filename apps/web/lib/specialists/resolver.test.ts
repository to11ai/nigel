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
    expect(linter?.model).toBe("anthropic/claude-haiku-4.5");
    expect(linter?.toolAllowlist).toEqual(["file", "search", "shell"]);
    expect(linter?.sandboxPolicy).toBe("fresh");
    expect(linter?.mayRecurse).toBe(false);
    expect(linter?.needsLocalStack).toBe(false);
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
