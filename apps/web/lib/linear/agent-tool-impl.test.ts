import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { buildForRun } from "./agent-tool-impl";
import { LinearClientError } from "./client";
import type { ResolvedLinearWorkspace } from "./workspace-repository";

// The adapter talks to Linear over `fetch` via the internal
// `linearGraphql` helper in `client.ts`. We stub `globalThis.fetch`
// per-test so the adapter believes it's talking to the real Linear
// API while we control the response sequence and observe the
// outgoing request bodies. This mirrors the pattern already used in
// `apps/web/app/api/chat/route.test.ts`.

type GraphqlCall = {
  url: string;
  body: { query: string; variables: Record<string, unknown> };
  headers: Record<string, string>;
};

const ORIGINAL_FETCH = globalThis.fetch;

function makeFakeWorkspace(): ResolvedLinearWorkspace {
  return {
    id: "ws-row-1",
    workspaceId: "linear-workspace-1",
    botUserId: "user-bot-1",
    teamRepoMap: {},
    secrets: {
      webhookSecret: "wh-secret",
      accessToken: "linear-access-token-abc",
    },
    createdAt: new Date("2026-01-01T00:00:00Z"),
    updatedAt: new Date("2026-01-01T00:00:00Z"),
  };
}

// Tiny scriptable fetch stub. The adapter never sends concurrent
// requests inside a single tool call (each call is sequential
// normalize → action), so a queue is sufficient and asserting on
// `calls.length` per scenario gives us the ordering guarantee we
// need for the normalization tests.
function installFetchScript(responses: Array<unknown>): {
  calls: GraphqlCall[];
} {
  const calls: GraphqlCall[] = [];
  let cursor = 0;
  globalThis.fetch = (async (
    url: RequestInfo | URL,
    init?: RequestInit,
  ) => {
    const bodyText =
      typeof init?.body === "string" ? init.body : String(init?.body ?? "{}");
    const body = JSON.parse(bodyText) as {
      query: string;
      variables: Record<string, unknown>;
    };
    calls.push({
      url: typeof url === "string" ? url : url.toString(),
      body,
      headers: (init?.headers as Record<string, string> | undefined) ?? {},
    });
    const next = responses[cursor++];
    if (next === undefined) {
      throw new Error(
        `installFetchScript: response queue exhausted at call #${cursor}`,
      );
    }
    if (next instanceof Response) return next;
    return new Response(JSON.stringify(next), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof globalThis.fetch;
  return { calls };
}

beforeEach(() => {
  // Reset to known-good state before each test in case a prior
  // test threw before its `afterEach` could restore.
  globalThis.fetch = ORIGINAL_FETCH;
});

afterEach(() => {
  globalThis.fetch = ORIGINAL_FETCH;
});

const UUID_ONE = "9cfb482e-1234-4abc-9def-0123456789ab";

describe("buildForRun.getIssue", () => {
  it("returns the agent-shaped issue on a successful fetch", async () => {
    const workspace = makeFakeWorkspace();
    const script = installFetchScript([
      {
        data: {
          issue: {
            id: UUID_ONE,
            identifier: "LIN-123",
            title: "Fix the build",
            description: "Body of the issue",
            url: "https://linear.app/foo/issue/LIN-123",
            state: { name: "In Progress" },
            assignee: { name: "Alice" },
            team: { key: "LIN" },
          },
        },
      },
    ]);
    const cb = buildForRun({
      runId: "run-1",
      orgId: "org-1",
      deps: { resolveLinearWorkspace: async () => workspace },
    });
    const result = await cb.getIssue({ issueId: UUID_ONE });
    expect(result).toEqual({
      id: UUID_ONE,
      identifier: "LIN-123",
      title: "Fix the build",
      description: "Body of the issue",
      statusName: "In Progress",
      assigneeName: "Alice",
      teamKey: "LIN",
      url: "https://linear.app/foo/issue/LIN-123",
    });
    // UUID input → no normalization round-trip.
    expect(script.calls.length).toBe(1);
    expect(script.calls[0]?.body.query).toContain("query IssueForAgent");
    expect(script.calls[0]?.body.variables.id).toBe(UUID_ONE);
    // Authorization header must carry the workspace's access token.
    expect(script.calls[0]?.headers.authorization).toBe(
      "Bearer linear-access-token-abc",
    );
  });

  it("normalizes team-prefixed shorthand via issueByIdentifier first", async () => {
    const workspace = makeFakeWorkspace();
    const script = installFetchScript([
      // First call: shorthand → GraphQL ID
      { data: { issueByIdentifier: { id: UUID_ONE } } },
      // Second call: full issue read using resolved id
      {
        data: {
          issue: {
            id: UUID_ONE,
            identifier: "LIN-123",
            title: "T",
            description: null,
            url: null,
            state: { name: "Backlog" },
            assignee: null,
            team: { key: "LIN" },
          },
        },
      },
    ]);
    const cb = buildForRun({
      runId: "run-1",
      orgId: "org-1",
      deps: { resolveLinearWorkspace: async () => workspace },
    });
    const result = await cb.getIssue({ issueId: "LIN-123" });
    expect("kind" in result).toBe(false);
    expect(script.calls.length).toBe(2);
    expect(script.calls[0]?.body.query).toContain("query IssueByIdentifier");
    expect(script.calls[0]?.body.variables).toEqual({
      team: "LIN",
      number: 123,
    });
    expect(script.calls[1]?.body.query).toContain("query IssueForAgent");
    expect(script.calls[1]?.body.variables.id).toBe(UUID_ONE);
  });

  it("skips the issueByIdentifier lookup when issueId is already a UUID", async () => {
    const workspace = makeFakeWorkspace();
    const script = installFetchScript([
      {
        data: {
          issue: {
            id: UUID_ONE,
            identifier: "LIN-99",
            title: "T",
            description: null,
            url: null,
            state: { name: "Done" },
            assignee: null,
            team: { key: "LIN" },
          },
        },
      },
    ]);
    const cb = buildForRun({
      runId: "run-1",
      orgId: "org-1",
      deps: { resolveLinearWorkspace: async () => workspace },
    });
    await cb.getIssue({ issueId: UUID_ONE });
    expect(script.calls.length).toBe(1);
    expect(script.calls[0]?.body.query).toContain("query IssueForAgent");
  });

  it("rejects malformed identifiers before any network call", async () => {
    const workspace = makeFakeWorkspace();
    const script = installFetchScript([]);
    const cb = buildForRun({
      runId: "run-1",
      orgId: "org-1",
      deps: { resolveLinearWorkspace: async () => workspace },
    });
    for (const bad of ["", "not-an-id", "LIN-", "-123", "LIN-abc"]) {
      let caught: unknown;
      try {
        await cb.getIssue({ issueId: bad });
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(LinearClientError);
      expect((caught as LinearClientError).code).toBe(
        "invalid_issue_identifier",
      );
    }
    // No fetch should have fired for any of those.
    expect(script.calls.length).toBe(0);
  });

  it("returns { kind: 'not_configured' } when no Linear workspace row exists", async () => {
    const script = installFetchScript([]);
    const cb = buildForRun({
      runId: "run-1",
      orgId: "org-1",
      deps: { resolveLinearWorkspace: async () => null },
    });
    const result = await cb.getIssue({ issueId: UUID_ONE });
    expect(result).toEqual({ kind: "not_configured" });
    expect(script.calls.length).toBe(0);
  });

  it("treats a resolveLinearWorkspace failure as not_configured", async () => {
    const script = installFetchScript([]);
    const cb = buildForRun({
      runId: "run-1",
      orgId: "org-1",
      deps: {
        resolveLinearWorkspace: async () => {
          throw new Error("DB unreachable");
        },
      },
    });
    const result = await cb.getIssue({ issueId: UUID_ONE });
    expect(result).toEqual({ kind: "not_configured" });
    expect(script.calls.length).toBe(0);
  });
});

describe("buildForRun.comment", () => {
  it("posts the commentCreate mutation and returns commentId + url", async () => {
    const workspace = makeFakeWorkspace();
    const script = installFetchScript([
      {
        data: {
          commentCreate: {
            success: true,
            comment: {
              id: "comment-123",
              url: "https://linear.app/foo/issue/LIN-1#comment-123",
            },
          },
        },
      },
    ]);
    const cb = buildForRun({
      runId: "run-1",
      orgId: "org-1",
      deps: { resolveLinearWorkspace: async () => workspace },
    });
    const result = await cb.comment({
      issueId: UUID_ONE,
      body: "hello world",
    });
    expect(result).toEqual({
      commentId: "comment-123",
      url: "https://linear.app/foo/issue/LIN-1#comment-123",
    });
    expect(script.calls.length).toBe(1);
    expect(script.calls[0]?.body.query).toContain("mutation CreateComment");
    expect(script.calls[0]?.body.variables).toEqual({
      issueId: UUID_ONE,
      body: "hello world",
    });
  });

  it("surfaces an HTTP 429 as a typed rate_limited LinearClientError", async () => {
    const workspace = makeFakeWorkspace();
    installFetchScript([
      new Response("rate limited", {
        status: 429,
        headers: { "retry-after": "30" },
      }),
    ]);
    const cb = buildForRun({
      runId: "run-1",
      orgId: "org-1",
      deps: { resolveLinearWorkspace: async () => workspace },
    });
    let caught: unknown;
    try {
      await cb.comment({ issueId: UUID_ONE, body: "hi" });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(LinearClientError);
    expect((caught as LinearClientError).code).toBe("rate_limited");
    expect((caught as LinearClientError).status).toBe(429);
  });

  it("returns not_configured when the workspace row is missing", async () => {
    installFetchScript([]);
    const cb = buildForRun({
      runId: "run-1",
      orgId: "org-1",
      deps: { resolveLinearWorkspace: async () => null },
    });
    const result = await cb.comment({ issueId: UUID_ONE, body: "x" });
    expect(result).toEqual({ kind: "not_configured" });
  });
});

describe("buildForRun.attach", () => {
  it("posts the attachmentCreate mutation with the expected variables", async () => {
    const workspace = makeFakeWorkspace();
    const script = installFetchScript([
      {
        data: {
          attachmentCreate: {
            success: true,
            attachment: { id: "att-42" },
          },
        },
      },
    ]);
    const cb = buildForRun({
      runId: "run-1",
      orgId: "org-1",
      deps: { resolveLinearWorkspace: async () => workspace },
    });
    const result = await cb.attach({
      issueId: UUID_ONE,
      url: "https://example.com/pr/1",
      title: "PR #1",
      subtitle: "Opened by Nigel",
    });
    expect(result).toEqual({ attachmentId: "att-42" });
    expect(script.calls.length).toBe(1);
    expect(script.calls[0]?.body.query).toContain("mutation CreateAttachment");
    expect(script.calls[0]?.body.variables).toEqual({
      issueId: UUID_ONE,
      url: "https://example.com/pr/1",
      title: "PR #1",
      subtitle: "Opened by Nigel",
    });
  });

  it("omits the subtitle on the wire when not supplied (passes null)", async () => {
    const workspace = makeFakeWorkspace();
    const script = installFetchScript([
      {
        data: {
          attachmentCreate: {
            success: true,
            attachment: { id: "att-43" },
          },
        },
      },
    ]);
    const cb = buildForRun({
      runId: "run-1",
      orgId: "org-1",
      deps: { resolveLinearWorkspace: async () => workspace },
    });
    await cb.attach({
      issueId: UUID_ONE,
      url: "https://example.com/pr/2",
      title: "PR #2",
    });
    expect(script.calls[0]?.body.variables.subtitle).toBeNull();
  });
});

describe("buildForRun id-resolution caching", () => {
  it("only resolves shorthand once across multiple operations in the same Run", async () => {
    const workspace = makeFakeWorkspace();
    const script = installFetchScript([
      // First call: shorthand → GraphQL ID for `comment` #1
      { data: { issueByIdentifier: { id: UUID_ONE } } },
      // Second call: commentCreate
      {
        data: {
          commentCreate: {
            success: true,
            comment: {
              id: "c-1",
              url: "https://linear.app/foo/issue/LIN-7#comment-c-1",
            },
          },
        },
      },
      // Third call: commentCreate #2 — id-resolution is cached, so
      // no second issueByIdentifier should fire.
      {
        data: {
          commentCreate: {
            success: true,
            comment: {
              id: "c-2",
              url: "https://linear.app/foo/issue/LIN-7#comment-c-2",
            },
          },
        },
      },
    ]);
    const cb = buildForRun({
      runId: "run-1",
      orgId: "org-1",
      deps: { resolveLinearWorkspace: async () => workspace },
    });
    await cb.comment({ issueId: "LIN-7", body: "first" });
    await cb.comment({ issueId: "LIN-7", body: "second" });
    // 1 normalize + 2 commentCreate = 3, not 4.
    expect(script.calls.length).toBe(3);
    expect(script.calls[0]?.body.query).toContain("query IssueByIdentifier");
    expect(script.calls[1]?.body.query).toContain("mutation CreateComment");
    expect(script.calls[2]?.body.query).toContain("mutation CreateComment");
    // Both commentCreate calls hit the resolved GraphQL id.
    expect(script.calls[1]?.body.variables.issueId).toBe(UUID_ONE);
    expect(script.calls[2]?.body.variables.issueId).toBe(UUID_ONE);
  });

  it("caches the workspace resolution too — only one resolveLinearWorkspace call per Run", async () => {
    const workspace = makeFakeWorkspace();
    installFetchScript([
      {
        data: {
          commentCreate: {
            success: true,
            comment: { id: "c-1", url: "" },
          },
        },
      },
      {
        data: {
          commentCreate: {
            success: true,
            comment: { id: "c-2", url: "" },
          },
        },
      },
    ]);
    let resolveCalls = 0;
    const cb = buildForRun({
      runId: "run-1",
      orgId: "org-1",
      deps: {
        resolveLinearWorkspace: async () => {
          resolveCalls++;
          return workspace;
        },
      },
    });
    await cb.comment({ issueId: UUID_ONE, body: "a" });
    await cb.comment({ issueId: UUID_ONE, body: "b" });
    expect(resolveCalls).toBe(1);
  });
});
