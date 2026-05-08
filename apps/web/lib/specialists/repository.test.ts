import { beforeEach, describe, expect, test } from "bun:test";
import { db } from "@/lib/db/client";
import { specialists } from "@/lib/db/schema";
import {
  deleteOverride,
  listSpecialists,
  upsertCustomSpecialist,
  upsertOverride,
} from "./repository";

beforeEach(async () => {
  await db.delete(specialists);
});

describe("specialists repository", () => {
  test("upsertCustomSpecialist creates and updates", async () => {
    const created = await upsertCustomSpecialist({
      name: "my-role",
      systemPrompt: "Be helpful",
      model: "anthropic/claude-haiku-4-5",
      toolAllowlist: ["file"],
      sandboxPolicy: "inherit",
      mayRecurse: false,
      maxChildren: 3,
      budgetUsdDefaultMicros: 1_000_000,
      needsLocalStack: false,
    });
    expect(created.kind).toBe("custom");
    expect(created.systemPrompt).toBe("Be helpful");

    const updated = await upsertCustomSpecialist({
      name: "my-role",
      systemPrompt: "Be very helpful",
      model: "anthropic/claude-haiku-4-5",
      toolAllowlist: ["file", "search"],
      sandboxPolicy: "inherit",
      mayRecurse: false,
      maxChildren: 5,
      budgetUsdDefaultMicros: 2_000_000,
      needsLocalStack: false,
    });
    expect(updated.systemPrompt).toBe("Be very helpful");
    expect(updated.maxChildren).toBe(5);
    expect(updated.id).toBe(created.id);
  });

  test("upsertOverride creates and updates partial overrides", async () => {
    const v1 = await upsertOverride("echo", { sandboxPolicy: "inherit" });
    expect(v1.kind).toBe("override");
    expect(v1.sandboxPolicy).toBe("inherit");

    const v2 = await upsertOverride("echo", {
      sandboxPolicy: "fresh_clean",
      maxChildren: 9,
    });
    expect(v2.id).toBe(v1.id);
    expect(v2.sandboxPolicy).toBe("fresh_clean");
    expect(v2.maxChildren).toBe(9);
  });

  test("deleteOverride removes the row", async () => {
    await upsertOverride("echo", { sandboxPolicy: "inherit" });
    await deleteOverride("echo");
    const all = await listSpecialists();
    expect(all.find((s) => s.name === "echo")).toBeUndefined();
  });

  test("upsertCustomSpecialist rejects names that collide with a code preset", async () => {
    await expect(
      upsertCustomSpecialist({
        name: "echo",
        systemPrompt: "x",
        model: "anthropic/claude-haiku-4-5",
        toolAllowlist: [],
        sandboxPolicy: "fresh",
        mayRecurse: false,
        maxChildren: 0,
        budgetUsdDefaultMicros: 0,
        needsLocalStack: false,
      }),
    ).rejects.toThrow(/code preset/i);
  });

  test("upsertOverride rejects names that are not code presets", async () => {
    await expect(
      upsertOverride("not-a-preset", { sandboxPolicy: "inherit" }),
    ).rejects.toThrow(/not a code preset/i);
  });

  test("listSpecialists returns rows in name order", async () => {
    await upsertOverride("echo", { sandboxPolicy: "inherit" });
    await upsertCustomSpecialist({
      name: "alpha",
      systemPrompt: "x",
      model: "anthropic/claude-haiku-4-5",
      toolAllowlist: [],
      sandboxPolicy: "fresh",
      mayRecurse: false,
      maxChildren: 0,
      budgetUsdDefaultMicros: 0,
      needsLocalStack: false,
    });
    const rows = await listSpecialists();
    expect(rows.map((r) => r.name)).toEqual(["alpha", "echo"]);
  });
});
