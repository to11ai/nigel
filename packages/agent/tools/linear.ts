import { tool } from "ai";
import { z } from "zod";

// Three Linear-touching tool wrappers for the planner: read an issue,
// post a markdown comment, attach a URL. All three share the same
// callback object shape supplied via `experimental_context.linear` —
// the agent package itself has no notion of Linear's GraphQL schema,
// auth flow, or workspace resolution; the dispatching layer
// (`apps/web/lib/linear/agent-tool-impl.ts`) owns all of that and
// passes a curried callback in at runtime.
//
// `issueId` on every operation accepts either Linear's team-prefixed
// shorthand (`"LIN-123"`, `"ENG-7"`) OR a Linear GraphQL ID. The
// adapter normalizes; the agent does not need to distinguish.
//
// When the org has no Linear workspace configured, the callback
// returns `{ kind: "not_configured" }` and these wrappers surface
// a graceful `{ success: false, error: "Linear is not configured ..." }`
// rather than a raw stack trace.
export type LinearAgentToolCallback = {
  getIssue: (input: { issueId: string }) => Promise<
    | {
        id: string;
        identifier: string;
        title: string;
        description: string | null;
        statusName: string;
        assigneeName: string | null;
        teamKey: string;
        url: string;
      }
    | { kind: "not_configured" }
  >;
  comment: (input: { issueId: string; body: string }) => Promise<
    { commentId: string; url: string } | { kind: "not_configured" }
  >;
  attach: (input: {
    issueId: string;
    url: string;
    title: string;
    subtitle?: string;
  }) => Promise<{ attachmentId: string } | { kind: "not_configured" }>;
};

interface LinearAgentToolContext {
  linear?: LinearAgentToolCallback;
}

const NOT_CONFIGURED_MESSAGE = "Linear is not configured for this org";

function isNotConfigured(value: unknown): value is { kind: "not_configured" } {
  return (
    typeof value === "object" &&
    value !== null &&
    "kind" in value &&
    (value as { kind?: unknown }).kind === "not_configured"
  );
}

// ---------------------------------------------------------------------------
// linear_get_issue
// ---------------------------------------------------------------------------

const linearGetIssueInputSchema = z.object({
  issue_id: z
    .string()
    .min(1)
    .describe(
      "Linear issue identifier. Accepts either the team-prefixed shorthand (e.g. 'LIN-123', 'ENG-7') OR a Linear GraphQL ID. The adapter normalizes both forms.",
    ),
});

export const linearGetIssueTool = tool({
  description: `Read a Linear issue's metadata and description.

Accepts either Linear's team-prefixed shorthand (e.g. \`LIN-123\`, \`ENG-7\`) OR a Linear GraphQL ID — the adapter normalizes both forms transparently.

Returns the issue's identifier, title, description (markdown), current status name, assignee name (if any), team key, and Linear URL. Use this to fetch the task description for a Linear-triggered Run before dispatching workers.`,
  inputSchema: linearGetIssueInputSchema,
  execute: async ({ issue_id }, { experimental_context }) => {
    const context = experimental_context as LinearAgentToolContext | undefined;
    const linear = context?.linear;
    if (!linear) {
      return {
        success: false,
        error:
          "linear_get_issue tool not wired: no callback in experimental_context. This is a runtime configuration bug, not something the agent can fix.",
      };
    }
    try {
      const result = await linear.getIssue({ issueId: issue_id });
      if (isNotConfigured(result)) {
        return { success: false, error: NOT_CONFIGURED_MESSAGE };
      }
      return {
        success: true,
        id: result.id,
        identifier: result.identifier,
        title: result.title,
        description: result.description,
        status_name: result.statusName,
        assignee_name: result.assigneeName,
        team_key: result.teamKey,
        url: result.url,
      };
    } catch (err) {
      return {
        success: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  },
});

// ---------------------------------------------------------------------------
// linear_comment
// ---------------------------------------------------------------------------

const linearCommentInputSchema = z.object({
  issue_id: z
    .string()
    .min(1)
    .describe(
      "Linear issue identifier. Accepts either the team-prefixed shorthand (e.g. 'LIN-123') OR a Linear GraphQL ID.",
    ),
  body: z
    .string()
    .min(1)
    .describe(
      "Markdown body of the comment. Linear renders its own markdown flavor; standard CommonMark generally works.",
    ),
});

export const linearCommentTool = tool({
  description: `Post a markdown comment on a Linear issue.

This is the planner's primary callback channel at end-of-Run for Linear-triggered Runs — wrap up by posting a final comment that summarizes what was done and includes the PR URL if a code change was made.

The body is markdown (Linear's flavor). Comments are NOT state changes — posting a comment does not transition the issue, change the assignee, or modify labels. Those routes go through the \`linear-engineer\` specialist with explicit authorization.

Accepts either Linear's team-prefixed shorthand (e.g. \`LIN-123\`) OR a Linear GraphQL ID for \`issue_id\`.`,
  inputSchema: linearCommentInputSchema,
  execute: async ({ issue_id, body }, { experimental_context }) => {
    const context = experimental_context as LinearAgentToolContext | undefined;
    const linear = context?.linear;
    if (!linear) {
      return {
        success: false,
        error:
          "linear_comment tool not wired: no callback in experimental_context. This is a runtime configuration bug, not something the agent can fix.",
      };
    }
    try {
      const result = await linear.comment({ issueId: issue_id, body });
      if (isNotConfigured(result)) {
        return { success: false, error: NOT_CONFIGURED_MESSAGE };
      }
      return {
        success: true,
        comment_id: result.commentId,
        url: result.url,
      };
    } catch (err) {
      return {
        success: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  },
});

// ---------------------------------------------------------------------------
// linear_attach
// ---------------------------------------------------------------------------

const linearAttachInputSchema = z.object({
  issue_id: z
    .string()
    .min(1)
    .describe(
      "Linear issue identifier. Accepts either the team-prefixed shorthand (e.g. 'LIN-123') OR a Linear GraphQL ID.",
    ),
  url: z
    .string()
    .url()
    .describe(
      "URL to attach to the issue (e.g. a PR URL or a visual-proof gallery URL).",
    ),
  title: z
    .string()
    .min(1)
    .describe("Display title for the attachment as it renders in Linear."),
  subtitle: z
    .string()
    .min(1)
    .optional()
    .describe(
      "Optional secondary line rendered under the attachment title in Linear.",
    ),
});

export const linearAttachTool = tool({
  description: `Attach a URL to a Linear issue.

Use this for PR links and visual-proof gallery links. Attachments are NOT state changes — attaching a URL does not transition the issue, change the assignee, or modify labels.

Call this in ADDITION to (not instead of) a \`linear_comment\` summarizing what was done — the comment carries the narrative, the attachment carries the structured link Linear can render inline.

Accepts either Linear's team-prefixed shorthand (e.g. \`LIN-123\`) OR a Linear GraphQL ID for \`issue_id\`.`,
  inputSchema: linearAttachInputSchema,
  execute: async (
    { issue_id, url, title, subtitle },
    { experimental_context },
  ) => {
    const context = experimental_context as LinearAgentToolContext | undefined;
    const linear = context?.linear;
    if (!linear) {
      return {
        success: false,
        error:
          "linear_attach tool not wired: no callback in experimental_context. This is a runtime configuration bug, not something the agent can fix.",
      };
    }
    try {
      const result = await linear.attach({
        issueId: issue_id,
        url,
        title,
        ...(subtitle !== undefined ? { subtitle } : {}),
      });
      if (isNotConfigured(result)) {
        return { success: false, error: NOT_CONFIGURED_MESSAGE };
      }
      return {
        success: true,
        attachment_id: result.attachmentId,
      };
    } catch (err) {
      return {
        success: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  },
});

export type LinearGetIssueInput = z.infer<typeof linearGetIssueInputSchema>;
export type LinearCommentInput = z.infer<typeof linearCommentInputSchema>;
export type LinearAttachInput = z.infer<typeof linearAttachInputSchema>;
