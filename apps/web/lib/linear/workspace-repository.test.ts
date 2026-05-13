import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { randomBytes } from "node:crypto";
import { db } from "@/lib/db/client";
import { linearWorkspace } from "@/lib/db/schema";
import { resetEncryptionKeyCacheForTests } from "@/lib/tool-connections/encryption";
import {
  createLinearWorkspace,
  deleteLinearWorkspace,
  getLinearWorkspace,
  getLinearWorkspaceByWorkspaceId,
  LinearWorkspaceRepositoryError,
  resolveLinearWorkspace,
  rowToListItem,
  updateLinearWorkspace,
} from "./workspace-repository";

const ORIGINAL_KEY = process.env.TOOL_CONNECTIONS_ENC_KEY;
const TEST_KEY_B64 = randomBytes(32).toString("base64");

beforeEach(async () => {
  process.env.TOOL_CONNECTIONS_ENC_KEY = TEST_KEY_B64;
  resetEncryptionKeyCacheForTests();
  await db.delete(linearWorkspace);
});

afterEach(() => {
  if (ORIGINAL_KEY === undefined) {
    delete process.env.TOOL_CONNECTIONS_ENC_KEY;
  } else {
    process.env.TOOL_CONNECTIONS_ENC_KEY = ORIGINAL_KEY;
  }
  resetEncryptionKeyCacheForTests();
});

const fixture = () => ({
  workspaceId: "ws-prod",
  botUserId: "user-nigel-bot",
  teamRepoMap: { "team-platform": "to11ai/nigel" } as Readonly<
    Record<string, string>
  >,
  secrets: {
    webhookSecret: "whsec_abc123",
    accessToken: "lin_oauth_xyz",
  },
});

describe("createLinearWorkspace", () => {
  test("creates a row and encrypts the secrets payload", async () => {
    const row = await createLinearWorkspace(fixture());
    expect(row.workspaceId).toBe("ws-prod");
    expect(row.botUserId).toBe("user-nigel-bot");
    // Plaintext must NOT survive in any field.
    expect(row.secretsCiphertext).not.toContain("whsec_abc123");
    expect(row.secretsCiphertext).not.toContain("lin_oauth_xyz");
  });

  test("defaults teamRepoMap to empty object", async () => {
    const row = await createLinearWorkspace({
      workspaceId: "ws-prod",
      botUserId: "user-nigel-bot",
      secrets: fixture().secrets,
    });
    expect(row.teamRepoMap).toEqual({});
  });

  test("throws already_exists on duplicate workspaceId", async () => {
    await createLinearWorkspace(fixture());
    try {
      await createLinearWorkspace(fixture());
      throw new Error("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(LinearWorkspaceRepositoryError);
      expect((err as LinearWorkspaceRepositoryError).code).toBe(
        "already_exists",
      );
    }
  });
});

describe("updateLinearWorkspace", () => {
  test("preserves existing secrets when secrets is omitted", async () => {
    const initial = await createLinearWorkspace(fixture());
    const before = {
      ciphertext: initial.secretsCiphertext,
      nonce: initial.secretsNonce,
    };
    const updated = await updateLinearWorkspace({
      id: initial.id,
      botUserId: "user-nigel-bot-renamed",
    });
    expect(updated.botUserId).toBe("user-nigel-bot-renamed");
    expect(updated.secretsCiphertext).toBe(before.ciphertext);
    expect(updated.secretsNonce).toBe(before.nonce);
  });

  test("rotates secrets when supplied", async () => {
    const initial = await createLinearWorkspace(fixture());
    const updated = await updateLinearWorkspace({
      id: initial.id,
      secrets: { webhookSecret: "new", accessToken: "fresh" },
    });
    expect(updated.secretsCiphertext).not.toBe(initial.secretsCiphertext);
    const resolved = await resolveLinearWorkspace();
    expect(resolved?.secrets.webhookSecret).toBe("new");
    expect(resolved?.secrets.accessToken).toBe("fresh");
  });

  test("updates teamRepoMap independently", async () => {
    const initial = await createLinearWorkspace(fixture());
    const updated = await updateLinearWorkspace({
      id: initial.id,
      teamRepoMap: { "team-other": "to11ai/other-repo" },
    });
    expect(updated.teamRepoMap).toEqual({
      "team-other": "to11ai/other-repo",
    });
  });

  test("throws not_found for an unknown id", async () => {
    await expect(
      updateLinearWorkspace({ id: "does-not-exist", botUserId: "x" }),
    ).rejects.toThrow(LinearWorkspaceRepositoryError);
  });
});

describe("resolveLinearWorkspace", () => {
  test("decrypts secrets and exposes the plaintext shape", async () => {
    await createLinearWorkspace(fixture());
    const resolved = await resolveLinearWorkspace();
    expect(resolved).not.toBeNull();
    expect(resolved?.secrets.webhookSecret).toBe("whsec_abc123");
    expect(resolved?.secrets.accessToken).toBe("lin_oauth_xyz");
    expect(resolved?.teamRepoMap).toEqual({ "team-platform": "to11ai/nigel" });
  });

  test("returns null when no row exists", async () => {
    const resolved = await resolveLinearWorkspace();
    expect(resolved).toBeNull();
  });

  test("coerces a malformed team_repo_map JSON value to empty object", async () => {
    // Sneak a non-string value into the team_repo_map via a direct
    // update — simulates a hand-edited or migration-corrupted row.
    await createLinearWorkspace(fixture());
    const row = await getLinearWorkspace();
    if (!row) throw new Error("seed row missing");
    await db
      .update(linearWorkspace)
      .set({
        teamRepoMap: { "team-platform": "to11ai/nigel", "team-other": 42 },
      })
      .where(eq(linearWorkspace.id, row.id));
    // The malformed entry is dropped; the well-formed one survives.
    const resolved = await resolveLinearWorkspace();
    expect(resolved?.teamRepoMap).toEqual({
      "team-platform": "to11ai/nigel",
    });
  });
});

describe("delete + lookup", () => {
  test("getLinearWorkspaceByWorkspaceId returns the row", async () => {
    await createLinearWorkspace(fixture());
    const row = await getLinearWorkspaceByWorkspaceId("ws-prod");
    expect(row?.workspaceId).toBe("ws-prod");
  });

  test("deleteLinearWorkspace removes the row", async () => {
    const row = await createLinearWorkspace(fixture());
    await deleteLinearWorkspace(row.id);
    const after = await getLinearWorkspace();
    expect(after).toBeNull();
  });

  test("deleteLinearWorkspace throws on unknown id", async () => {
    await expect(deleteLinearWorkspace("does-not-exist")).rejects.toThrow(
      LinearWorkspaceRepositoryError,
    );
  });
});

describe("rowToListItem", () => {
  test("excludes the encrypted secrets columns", async () => {
    const row = await createLinearWorkspace(fixture());
    const item = rowToListItem(row);
    // The list item shape is hand-typed to exclude these; if a
    // future refactor accidentally widens it, this test fails.
    expect((item as Record<string, unknown>).secretsCiphertext).toBeUndefined();
    expect((item as Record<string, unknown>).secretsNonce).toBeUndefined();
    expect((item as Record<string, unknown>).secretsAuthTag).toBeUndefined();
  });
});
