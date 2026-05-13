import { tool } from "ai";
import { z } from "zod";

// Same callback-via-experimental_context pattern as the other
// tool_connections-backed tools. The agent package doesn't know how
// to talk to Slack; the dispatching layer (apps/web) supplies a
// curried callback that owns connection resolution and the actual
// HTTPS POST.
//
// Only one operation: `post_message`. Slack incoming webhooks are
// inherently write-only and channel-locked at creation time, so
// there is no `list_*` discovery step and no per-call channel
// override.
//
// `blocks` is a passthrough — the LLM constructs Block Kit JSON
// against Slack's documented schema and we forward it verbatim. We
// deliberately don't model the block schema at the agent layer
// because (a) it's deeply nested and changes frequently, and (b)
// Slack itself returns clear errors when the payload is wrong.
export type SlackPostCallback = (input: {
  connectionName: string;
  text: string;
  blocks?: ReadonlyArray<Record<string, unknown>>;
  usernameOverride?: string;
}) => Promise<{
  ok: boolean;
  channel?: string;
}>;

interface SlackPostContext {
  slackPost?: SlackPostCallback;
}

const slackPostInputSchema = z.object({
  connection_name: z
    .string()
    .min(1)
    .describe(
      "Name of a tool_connection of kind 'slack' to post through. Must be a connection your specialist's scope can resolve.",
    ),
  text: z
    .string()
    .min(1)
    .describe(
      "Plain-text fallback message body. Required even when `blocks` is set — Slack uses `text` for notifications and for clients that can't render Block Kit.",
    ),
  blocks: z
    .array(z.record(z.string(), z.unknown()))
    .optional()
    .describe(
      "Optional Block Kit blocks (https://api.slack.com/block-kit). Each entry is a single block object. Forwarded verbatim to Slack.",
    ),
  username_override: z
    .string()
    .min(1)
    .optional()
    .describe(
      "Optional bot display name to override the webhook's default. Only honored if the Slack workspace allows webhook username overrides.",
    ),
});

const slackPostOutputSchema = z.discriminatedUnion("success", [
  z.object({
    success: z.literal(true),
    connection: z.string(),
    ok: z.boolean(),
    channel: z.string().optional(),
  }),
  z.object({
    success: z.literal(false),
    connection: z.string(),
    error: z.string(),
  }),
]);

export const slackPostTool = tool({
  description: `Post a message to a Slack channel via a registered incoming webhook.

The connection's webhook URL is channel-locked at creation, so you cannot choose a channel per call — that's a property of the registered connection.

\`text\` is required even when you supply \`blocks\`: Slack uses \`text\` for notification previews and for clients that can't render Block Kit.

Block Kit reference: https://api.slack.com/block-kit. The \`blocks\` array is forwarded to Slack verbatim; on a malformed payload Slack returns a 4xx with a descriptive error and this tool surfaces that error text in \`error\`.

This is a write-only tool — there is no equivalent read operation. If the connection name doesn't exist or your specialist's scope can't reach it, the tool returns a configuration error.`,
  inputSchema: slackPostInputSchema,
  outputSchema: slackPostOutputSchema,
  execute: async (
    { connection_name, text, blocks, username_override },
    { experimental_context },
  ) => {
    const context = experimental_context as SlackPostContext | undefined;
    const callback = context?.slackPost;
    if (!callback) {
      return {
        success: false as const,
        connection: connection_name,
        error:
          "slack_post tool not wired: no callback in experimental_context. This is a runtime configuration bug, not something the agent can fix.",
      };
    }
    try {
      const result = await callback({
        connectionName: connection_name,
        text,
        ...(blocks !== undefined ? { blocks } : {}),
        ...(username_override !== undefined
          ? { usernameOverride: username_override }
          : {}),
      });
      return {
        success: true as const,
        connection: connection_name,
        ok: result.ok,
        ...(result.channel !== undefined ? { channel: result.channel } : {}),
      };
    } catch (err) {
      return {
        success: false as const,
        connection: connection_name,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  },
});

export type SlackPostInput = z.infer<typeof slackPostInputSchema>;
