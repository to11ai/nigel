import { describe, expect, mock, test } from "bun:test";
import type { z } from "zod";

mock.module("ai", () => ({
  tool: <T extends Record<string, unknown>>(definition: T) => definition,
}));

const { linearAttachTool, linearCommentTool, linearGetIssueTool } =
  await import("./linear");

// The AI SDK `tool()` factory hides the zod schema behind `FlexibleSchema`
// at the type level. The test-time mock above returns the definition
// verbatim, so at runtime each `inputSchema` is the actual zod schema —
// `safeParse` exists and works. The casts just bridge the static gap.
const getIssueSchema = linearGetIssueTool.inputSchema as unknown as z.ZodTypeAny;
const commentSchema = linearCommentTool.inputSchema as unknown as z.ZodTypeAny;
const attachSchema = linearAttachTool.inputSchema as unknown as z.ZodTypeAny;

function executionOptions(experimental_context?: unknown) {
  return {
    toolCallId: "tool-call-1",
    messages: [],
    experimental_context,
  };
}

const ISSUE_PAYLOAD = {
  id: "uuid-issue-1",
  identifier: "LIN-123",
  title: "Fix the bug",
  description: "Something broke",
  statusName: "In Progress",
  assigneeName: "Alice",
  teamKey: "LIN",
  url: "https://linear.app/team/issue/LIN-123",
};

describe("linearGetIssueTool", () => {
  test("schema rejects empty issue_id", () => {
    const result = getIssueSchema.safeParse({ issue_id: "" });
    expect(result.success).toBe(false);
  });

  test("schema accepts a short identifier", () => {
    const result = getIssueSchema.safeParse({
      issue_id: "LIN-123",
    });
    expect(result.success).toBe(true);
  });

  test("calls getIssue exactly once with normalized input", async () => {
    let callCount = 0;
    let lastInput: { issueId: string } | undefined;

    const linear = {
      getIssue: async (input: { issueId: string }) => {
        callCount += 1;
        lastInput = input;
        return ISSUE_PAYLOAD;
      },
      comment: async () => {
        throw new Error("comment should not be called");
      },
      attach: async () => {
        throw new Error("attach should not be called");
      },
    };

    const result = await linearGetIssueTool.execute?.(
      { issue_id: "LIN-123" },
      executionOptions({ linear }),
    );

    expect(callCount).toBe(1);
    expect(lastInput).toEqual({ issueId: "LIN-123" });
    expect(result).toEqual({
      success: true,
      id: "uuid-issue-1",
      identifier: "LIN-123",
      title: "Fix the bug",
      description: "Something broke",
      status_name: "In Progress",
      assignee_name: "Alice",
      team_key: "LIN",
      url: "https://linear.app/team/issue/LIN-123",
    });
  });

  test("missing callback returns success:false with wired error", async () => {
    const result = await linearGetIssueTool.execute?.(
      { issue_id: "LIN-123" },
      executionOptions({}),
    );

    expect(result).toEqual({
      success: false,
      error:
        "linear_get_issue tool not wired: no callback in experimental_context. This is a runtime configuration bug, not something the agent can fix.",
    });
  });

  test("not_configured surfaces as graceful error", async () => {
    const linear = {
      getIssue: async () => ({ kind: "not_configured" as const }),
      comment: async () => ({ kind: "not_configured" as const }),
      attach: async () => ({ kind: "not_configured" as const }),
    };

    const result = await linearGetIssueTool.execute?.(
      { issue_id: "LIN-123" },
      executionOptions({ linear }),
    );

    expect(result).toEqual({
      success: false,
      error: "Linear is not configured for this org",
    });
  });

  test("thrown callback error surfaces as success:false with err.message", async () => {
    const linear = {
      getIssue: async () => {
        throw new Error("invalid_issue_identifier");
      },
      comment: async () => ({ kind: "not_configured" as const }),
      attach: async () => ({ kind: "not_configured" as const }),
    };

    const result = await linearGetIssueTool.execute?.(
      { issue_id: "LIN-" },
      executionOptions({ linear }),
    );

    expect(result).toEqual({
      success: false,
      error: "invalid_issue_identifier",
    });
  });
});

describe("linearCommentTool", () => {
  test("schema rejects empty body", () => {
    const result = commentSchema.safeParse({
      issue_id: "LIN-123",
      body: "",
    });
    expect(result.success).toBe(false);
  });

  test("schema rejects empty issue_id", () => {
    const result = commentSchema.safeParse({
      issue_id: "",
      body: "hi",
    });
    expect(result.success).toBe(false);
  });

  test("schema accepts a non-empty body", () => {
    const result = commentSchema.safeParse({
      issue_id: "LIN-123",
      body: "Run complete. PR: https://example.com",
    });
    expect(result.success).toBe(true);
  });

  test("calls comment exactly once with normalized input", async () => {
    let callCount = 0;
    let lastInput: { issueId: string; body: string } | undefined;

    const linear = {
      getIssue: async () => ISSUE_PAYLOAD,
      comment: async (input: { issueId: string; body: string }) => {
        callCount += 1;
        lastInput = input;
        return {
          commentId: "comment-1",
          url: "https://linear.app/team/issue/LIN-123#comment-1",
        };
      },
      attach: async () => {
        throw new Error("attach should not be called");
      },
    };

    const result = await linearCommentTool.execute?.(
      { issue_id: "LIN-123", body: "all good" },
      executionOptions({ linear }),
    );

    expect(callCount).toBe(1);
    expect(lastInput).toEqual({ issueId: "LIN-123", body: "all good" });
    expect(result).toEqual({
      success: true,
      comment_id: "comment-1",
      url: "https://linear.app/team/issue/LIN-123#comment-1",
    });
  });

  test("missing callback returns success:false with wired error", async () => {
    const result = await linearCommentTool.execute?.(
      { issue_id: "LIN-123", body: "hi" },
      executionOptions({}),
    );

    expect(result).toEqual({
      success: false,
      error:
        "linear_comment tool not wired: no callback in experimental_context. This is a runtime configuration bug, not something the agent can fix.",
    });
  });

  test("not_configured surfaces as graceful error", async () => {
    const linear = {
      getIssue: async () => ISSUE_PAYLOAD,
      comment: async () => ({ kind: "not_configured" as const }),
      attach: async () => ({ kind: "not_configured" as const }),
    };

    const result = await linearCommentTool.execute?.(
      { issue_id: "LIN-123", body: "hi" },
      executionOptions({ linear }),
    );

    expect(result).toEqual({
      success: false,
      error: "Linear is not configured for this org",
    });
  });
});

describe("linearAttachTool", () => {
  test("schema rejects malformed URL", () => {
    const result = attachSchema.safeParse({
      issue_id: "LIN-123",
      url: "not-a-url",
      title: "PR",
    });
    expect(result.success).toBe(false);
  });

  test("schema rejects empty title", () => {
    const result = attachSchema.safeParse({
      issue_id: "LIN-123",
      url: "https://github.com/x/y/pull/1",
      title: "",
    });
    expect(result.success).toBe(false);
  });

  test("schema rejects empty issue_id", () => {
    const result = attachSchema.safeParse({
      issue_id: "",
      url: "https://github.com/x/y/pull/1",
      title: "PR",
    });
    expect(result.success).toBe(false);
  });

  test("schema accepts a well-formed URL", () => {
    const result = attachSchema.safeParse({
      issue_id: "LIN-123",
      url: "https://github.com/x/y/pull/1",
      title: "PR #1",
    });
    expect(result.success).toBe(true);
  });

  test("schema accepts optional subtitle", () => {
    const result = attachSchema.safeParse({
      issue_id: "LIN-123",
      url: "https://github.com/x/y/pull/1",
      title: "PR #1",
      subtitle: "merged",
    });
    expect(result.success).toBe(true);
  });

  test("calls attach exactly once with normalized input (subtitle omitted)", async () => {
    let callCount = 0;
    let lastInput:
      | {
          issueId: string;
          url: string;
          title: string;
          subtitle?: string;
        }
      | undefined;

    const linear = {
      getIssue: async () => ISSUE_PAYLOAD,
      comment: async () => {
        throw new Error("comment should not be called");
      },
      attach: async (input: {
        issueId: string;
        url: string;
        title: string;
        subtitle?: string;
      }) => {
        callCount += 1;
        lastInput = input;
        return { attachmentId: "att-1" };
      },
    };

    const result = await linearAttachTool.execute?.(
      {
        issue_id: "LIN-123",
        url: "https://github.com/x/y/pull/1",
        title: "PR #1",
      },
      executionOptions({ linear }),
    );

    expect(callCount).toBe(1);
    expect(lastInput).toEqual({
      issueId: "LIN-123",
      url: "https://github.com/x/y/pull/1",
      title: "PR #1",
    });
    expect(result).toEqual({
      success: true,
      attachment_id: "att-1",
    });
  });

  test("calls attach with subtitle when provided", async () => {
    let lastInput:
      | {
          issueId: string;
          url: string;
          title: string;
          subtitle?: string;
        }
      | undefined;

    const linear = {
      getIssue: async () => ISSUE_PAYLOAD,
      comment: async () => {
        throw new Error("comment should not be called");
      },
      attach: async (input: {
        issueId: string;
        url: string;
        title: string;
        subtitle?: string;
      }) => {
        lastInput = input;
        return { attachmentId: "att-2" };
      },
    };

    await linearAttachTool.execute?.(
      {
        issue_id: "LIN-123",
        url: "https://github.com/x/y/pull/1",
        title: "PR #1",
        subtitle: "merged",
      },
      executionOptions({ linear }),
    );

    expect(lastInput).toEqual({
      issueId: "LIN-123",
      url: "https://github.com/x/y/pull/1",
      title: "PR #1",
      subtitle: "merged",
    });
  });

  test("missing callback returns success:false with wired error", async () => {
    const result = await linearAttachTool.execute?.(
      {
        issue_id: "LIN-123",
        url: "https://github.com/x/y/pull/1",
        title: "PR #1",
      },
      executionOptions({}),
    );

    expect(result).toEqual({
      success: false,
      error:
        "linear_attach tool not wired: no callback in experimental_context. This is a runtime configuration bug, not something the agent can fix.",
    });
  });

  test("not_configured surfaces as graceful error", async () => {
    const linear = {
      getIssue: async () => ISSUE_PAYLOAD,
      comment: async () => ({ kind: "not_configured" as const }),
      attach: async () => ({ kind: "not_configured" as const }),
    };

    const result = await linearAttachTool.execute?.(
      {
        issue_id: "LIN-123",
        url: "https://github.com/x/y/pull/1",
        title: "PR #1",
      },
      executionOptions({ linear }),
    );

    expect(result).toEqual({
      success: false,
      error: "Linear is not configured for this org",
    });
  });
});
