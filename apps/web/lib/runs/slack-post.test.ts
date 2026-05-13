import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { db } from "@/lib/db/client";
import { toolConnections } from "@/lib/db/schema";
import { createToolConnection } from "@/lib/tool-connections";
import { resetEncryptionKeyCacheForTests } from "@/lib/tool-connections/encryption";
import { createSlackPostCallback, SlackPostError } from "./slack-post";

const ORIGINAL_KEY = process.env.TOOL_CONNECTIONS_ENC_KEY;
const TEST_KEY_B64 = randomBytes(32).toString("base64");

// Capture-and-replace globalThis.fetch so each test can assert on the
// outbound request and stub the Slack response without hitting the
// network. ioredis / postgres tests use their respective protocols at
// loopback; Slack only talks HTTPS so a fetch stub is the cleanest
// seam.
type FetchStub = (
  input: Request | string | URL,
  init?: RequestInit,
) => Promise<Response>;
const ORIGINAL_FETCH = globalThis.fetch;
let lastRequest: { url: string; init?: RequestInit } | null = null;

beforeEach(async () => {
  process.env.TOOL_CONNECTIONS_ENC_KEY = TEST_KEY_B64;
  resetEncryptionKeyCacheForTests();
  await db.delete(toolConnections);
  lastRequest = null;
});

afterEach(() => {
  if (ORIGINAL_KEY === undefined) {
    delete process.env.TOOL_CONNECTIONS_ENC_KEY;
  } else {
    process.env.TOOL_CONNECTIONS_ENC_KEY = ORIGINAL_KEY;
  }
  resetEncryptionKeyCacheForTests();
  globalThis.fetch = ORIGINAL_FETCH;
});

function stubFetch(stub: FetchStub): void {
  globalThis.fetch = (async (input, init) => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url;
    lastRequest = { url, ...(init !== undefined ? { init } : {}) };
    return stub(input, init);
  }) as typeof fetch;
}

const seedSlackConnection = async (
  overrides: {
    name?: string;
    scope?: { kind: "global" } | { kind: "specialist"; specialistName: string };
    webhookUrl?: string;
    channel?: string;
    username?: string;
  } = {},
) => {
  return createToolConnection({
    name: overrides.name ?? "test-slack",
    kind: "slack",
    config: {
      channel: overrides.channel ?? "#test",
      ...(overrides.username !== undefined
        ? { username: overrides.username }
        : {}),
    },
    secrets: {
      webhookUrl:
        overrides.webhookUrl ?? "https://hooks.slack.com/services/T/B/X",
    },
    ...(overrides.scope ? { scope: overrides.scope } : {}),
  });
};

describe("createSlackPostCallback — pre-execute checks", () => {
  test("throws connection_not_resolvable for an unknown name", async () => {
    const cb = createSlackPostCallback({ specialistName: "reporter" });
    try {
      await cb({ connectionName: "no_such", text: "hi" });
      throw new Error("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(SlackPostError);
      expect((err as SlackPostError).code).toBe("connection_not_resolvable");
    }
  });

  test("throws wrong_kind for a postgres-kind connection", async () => {
    await createToolConnection({
      name: "test-pg",
      kind: "postgres",
      config: { host: "127.0.0.1", database: "appdb", user: "reader" },
      secrets: { password: "x" },
    });
    const cb = createSlackPostCallback({ specialistName: "reporter" });
    try {
      await cb({ connectionName: "test-pg", text: "hi" });
      throw new Error("expected throw");
    } catch (err) {
      expect((err as SlackPostError).code).toBe("wrong_kind");
    }
  });

  test("throws scope_denied when specialist scope mismatches", async () => {
    await seedSlackConnection({
      scope: { kind: "specialist", specialistName: "other" },
    });
    const cb = createSlackPostCallback({ specialistName: "reporter" });
    try {
      await cb({ connectionName: "test-slack", text: "hi" });
      throw new Error("expected throw");
    } catch (err) {
      expect((err as SlackPostError).code).toBe("scope_denied");
    }
  });

  test("permits a global-scoped connection regardless of specialist name", async () => {
    await seedSlackConnection({ scope: { kind: "global" } });
    stubFetch(async () => new Response("ok", { status: 200 }));
    const cb = createSlackPostCallback({ specialistName: "anything" });
    const result = await cb({ connectionName: "test-slack", text: "hi" });
    expect(result.ok).toBe(true);
  });

  test("permits a specialist-scoped connection whose name matches", async () => {
    await seedSlackConnection({
      scope: { kind: "specialist", specialistName: "reporter" },
    });
    stubFetch(async () => new Response("ok", { status: 200 }));
    const cb = createSlackPostCallback({ specialistName: "reporter" });
    const result = await cb({ connectionName: "test-slack", text: "hi" });
    expect(result.ok).toBe(true);
  });
});

describe("createSlackPostCallback — payload + transport", () => {
  test("POSTs JSON to the webhook URL with text in the body", async () => {
    await seedSlackConnection({
      webhookUrl: "https://hooks.slack.com/services/T/B/secret",
    });
    stubFetch(async () => new Response("ok", { status: 200 }));
    const cb = createSlackPostCallback({ specialistName: "reporter" });
    await cb({ connectionName: "test-slack", text: "hello world" });

    expect(lastRequest).not.toBeNull();
    const captured = lastRequest as NonNullable<typeof lastRequest>;
    expect(captured.url).toBe("https://hooks.slack.com/services/T/B/secret");
    expect(captured.init?.method).toBe("POST");
    const headers = captured.init?.headers as Record<string, string>;
    expect(headers["content-type"]).toBe("application/json");
    const body = JSON.parse(captured.init?.body as string);
    expect(body.text).toBe("hello world");
  });

  test("forwards blocks verbatim when supplied", async () => {
    await seedSlackConnection();
    stubFetch(async () => new Response("ok", { status: 200 }));
    const cb = createSlackPostCallback({ specialistName: "reporter" });
    const blocks = [
      { type: "section", text: { type: "mrkdwn", text: "*bold*" } },
    ];
    await cb({ connectionName: "test-slack", text: "fallback", blocks });
    const body = JSON.parse(lastRequest?.init?.body as string);
    expect(body.blocks).toEqual(blocks);
    expect(body.text).toBe("fallback");
  });

  test("includes username from config when set", async () => {
    await seedSlackConnection({ username: "nigel-bot" });
    stubFetch(async () => new Response("ok", { status: 200 }));
    const cb = createSlackPostCallback({ specialistName: "reporter" });
    await cb({ connectionName: "test-slack", text: "hi" });
    const body = JSON.parse(lastRequest?.init?.body as string);
    expect(body.username).toBe("nigel-bot");
  });

  test("per-call usernameOverride beats connection-level username", async () => {
    await seedSlackConnection({ username: "default-bot" });
    stubFetch(async () => new Response("ok", { status: 200 }));
    const cb = createSlackPostCallback({ specialistName: "reporter" });
    await cb({
      connectionName: "test-slack",
      text: "hi",
      usernameOverride: "override-bot",
    });
    const body = JSON.parse(lastRequest?.init?.body as string);
    expect(body.username).toBe("override-bot");
  });

  test("omits username when neither config nor override is set", async () => {
    await seedSlackConnection();
    stubFetch(async () => new Response("ok", { status: 200 }));
    const cb = createSlackPostCallback({ specialistName: "reporter" });
    await cb({ connectionName: "test-slack", text: "hi" });
    const body = JSON.parse(lastRequest?.init?.body as string);
    expect("username" in body).toBe(false);
  });

  test("returns ok=false when Slack body is not the literal 'ok'", async () => {
    await seedSlackConnection();
    // Slack returns 200 with `ok` on success. A 200 with any other
    // body (e.g. a Slack rate-limit retry-after notice on the same
    // status) should surface as ok=false but not throw.
    stubFetch(async () => new Response("muted_channel", { status: 200 }));
    const cb = createSlackPostCallback({ specialistName: "reporter" });
    const result = await cb({ connectionName: "test-slack", text: "hi" });
    expect(result.ok).toBe(false);
  });

  test("throws execution_failed on a non-2xx response with Slack's error text", async () => {
    await seedSlackConnection();
    stubFetch(async () => new Response("invalid_payload", { status: 400 }));
    const cb = createSlackPostCallback({ specialistName: "reporter" });
    try {
      await cb({ connectionName: "test-slack", text: "hi" });
      throw new Error("expected throw");
    } catch (err) {
      expect((err as SlackPostError).code).toBe("execution_failed");
      expect((err as SlackPostError).message).toContain("invalid_payload");
      expect((err as SlackPostError).message).toContain("400");
    }
  });

  test("throws execution_failed when the payload exceeds the cap", async () => {
    await seedSlackConnection();
    // Don't stub fetch — the cap check fires before the request.
    const cb = createSlackPostCallback({ specialistName: "reporter" });
    const huge = "x".repeat(40_000);
    try {
      await cb({ connectionName: "test-slack", text: huge });
      throw new Error("expected throw");
    } catch (err) {
      expect((err as SlackPostError).code).toBe("execution_failed");
      expect((err as SlackPostError).message).toMatch(/payload is \d+ bytes/);
    }
  });

  test("surfaces config channel in the result for confirmation", async () => {
    await seedSlackConnection({ channel: "#alerts" });
    stubFetch(async () => new Response("ok", { status: 200 }));
    const cb = createSlackPostCallback({ specialistName: "reporter" });
    const result = await cb({ connectionName: "test-slack", text: "hi" });
    expect(result.channel).toBe("#alerts");
  });
});
