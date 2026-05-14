// Phase 6 L3: thin GraphQL client for the Linear API. Used by:
//   - failure-path comments from the webhook handler (no repo
//     mapped, actor not mapped to a Nigel user)
//   - lifecycle hooks that comment + reassign on agent_runs
//     status transitions per the spec's state-transition table
//
// Authenticates with the workspace's stored OAuth access token.
// The full secrets bag (including the token) is decrypted by
// `resolveLinearWorkspace` — the client never reads env vars or
// DB rows itself, so callers can swap in test fixtures easily.

const LINEAR_GRAPHQL_ENDPOINT = "https://api.linear.app/graphql";

export class LinearClientError extends Error {
  readonly code:
    | "http_error"
    | "graphql_error"
    | "missing_data"
    | "rate_limited";
  readonly status?: number;
  constructor(
    code: "http_error" | "graphql_error" | "missing_data" | "rate_limited",
    message: string,
    status?: number,
  ) {
    super(message);
    this.name = "LinearClientError";
    this.code = code;
    if (status !== undefined) this.status = status;
  }
}

// Linear's REQUEST timeout — bounds slow / hung calls. 15s is
// well below the webhook handler's effective deadline and gives
// Linear plenty of headroom for healthy responses.
const REQUEST_TIMEOUT_MS = 15_000;

async function linearGraphql<TData>(input: {
  accessToken: string;
  query: string;
  variables: Record<string, unknown>;
}): Promise<TData> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(LINEAR_GRAPHQL_ENDPOINT, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${input.accessToken}`,
      },
      body: JSON.stringify({ query: input.query, variables: input.variables }),
      signal: controller.signal,
    });
    if (res.status === 429) {
      throw new LinearClientError(
        "rate_limited",
        `Linear API rate-limited (HTTP 429); retry-after=${res.headers.get("retry-after") ?? "unspecified"}`,
        429,
      );
    }
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new LinearClientError(
        "http_error",
        `Linear API responded ${res.status}: ${body.slice(0, 200)}`,
        res.status,
      );
    }
    const json = (await res.json()) as {
      data?: TData;
      errors?: Array<{ message?: string }>;
    };
    if (json.errors && json.errors.length > 0) {
      const messages = json.errors
        .map((e) => e.message ?? "(no message)")
        .join("; ");
      throw new LinearClientError(
        "graphql_error",
        `Linear GraphQL errors: ${messages}`,
      );
    }
    if (!json.data) {
      throw new LinearClientError(
        "missing_data",
        "Linear GraphQL response has no data field",
      );
    }
    return json.data;
  } catch (err) {
    if (err instanceof LinearClientError) throw err;
    if (err instanceof Error && err.name === "AbortError") {
      throw new LinearClientError(
        "http_error",
        `Linear API request timed out after ${REQUEST_TIMEOUT_MS}ms`,
      );
    }
    throw new LinearClientError(
      "http_error",
      err instanceof Error ? err.message : String(err),
    );
  } finally {
    clearTimeout(timer);
  }
}

// Posts a comment on a Linear issue. Returns the new comment's id
// for caller-side audit / dedup. Body is Markdown — Linear renders
// it in-app.
export async function commentOnIssue(input: {
  accessToken: string;
  issueId: string;
  body: string;
}): Promise<{ commentId: string }> {
  const data = await linearGraphql<{
    commentCreate: { success: boolean; comment?: { id: string } };
  }>({
    accessToken: input.accessToken,
    query: `
      mutation CreateComment($issueId: String!, $body: String!) {
        commentCreate(input: { issueId: $issueId, body: $body }) {
          success
          comment { id }
        }
      }
    `,
    variables: { issueId: input.issueId, body: input.body },
  });
  if (!data.commentCreate.success || !data.commentCreate.comment) {
    throw new LinearClientError(
      "graphql_error",
      `commentCreate returned success=false for issue ${input.issueId}`,
    );
  }
  return { commentId: data.commentCreate.comment.id };
}

// Fetches the minimal issue fields the trigger pipeline needs.
// Phase 6 L4 calls this from the `/run` comment-command path —
// Linear's `Comment.create` webhook only carries the comment + its
// issueId, so we round-trip to GraphQL to pull title / description /
// labels / attachments needed for repo resolution and the planner
// prompt.
//
// Returns the raw shape that `parseLinearIssue` in event-schema can
// consume directly. The shape mirrors what Linear delivers on
// `Issue.assignee_changed` so a single downstream code path handles
// both intake routes.
export async function fetchIssue(input: {
  accessToken: string;
  issueId: string;
}): Promise<{
  id: string;
  identifier: string;
  title: string;
  // Linear sometimes returns description as null; the schema accepts
  // null OR undefined, so keep null fidelity here.
  description: string | null;
  teamId: string;
  // The remaining optional fields use `undefined` (not null) so the
  // shape matches `linearIssueSchema`, which declares them via
  // `.optional()` — that accepts `undefined`/missing only. Returning
  // `null` would make `parseLinearIssue` reject the result and
  // surface as a misleading "issue not found" for any issue with
  // non-GitHub attachments.
  url: string | undefined;
  creator: { id: string } | null;
  labels: Array<{ name: string }>;
  attachments: Array<{
    url: string | undefined;
    metadata: { url: string } | undefined;
  }>;
} | null> {
  const data = await linearGraphql<{
    issue: {
      id: string;
      identifier: string;
      title: string;
      description: string | null;
      url: string | null;
      team: { id: string };
      creator: { id: string } | null;
      labels: { nodes: Array<{ name: string }> };
      attachments: {
        nodes: Array<{ url: string | null; metadata: unknown }>;
      };
    } | null;
  }>({
    accessToken: input.accessToken,
    query: `
      query Issue($id: String!) {
        issue(id: $id) {
          id
          identifier
          title
          description
          url
          team { id }
          creator { id }
          labels(first: 50) { nodes { name } }
          attachments(first: 25) { nodes { url metadata } }
        }
      }
    `,
    variables: { id: input.issueId },
  });
  if (!data.issue) return null;
  return {
    id: data.issue.id,
    identifier: data.issue.identifier,
    title: data.issue.title,
    description: data.issue.description,
    teamId: data.issue.team.id,
    url: data.issue.url ?? undefined,
    creator: data.issue.creator,
    labels: data.issue.labels.nodes,
    attachments: data.issue.attachments.nodes.map((a) => ({
      url: a.url ?? undefined,
      metadata:
        isObject(a.metadata) && typeof a.metadata.url === "string"
          ? { url: a.metadata.url }
          : undefined,
    })),
  };
}

function isObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object";
}

// AgentActivity: posts a streamed status / step event to a
// Linear AgentSession's panel UI. This is the API Linear's
// session-panel uses to render "the agent is working" content —
// without it, the panel shows "did not respond" even when the
// agent posts comments on the underlying issue.
//
// Linear's docs describe four `kind` values:
//   - "thought"  — internal reasoning / planning steps
//   - "action"   — tool calls, side-effects
//   - "response" — user-visible reply text
//   - "error"    — failure / blocked status
//
// `body` is Markdown rendered in the session panel. The Linear
// session UI surfaces these chronologically, so callers should
// emit them in step order.
//
// We do NOT throw on a "false" `success` field here — the session
// might have been closed by the user, in which case Linear returns
// success=false. Callers treat AgentActivity as fire-and-forget
// telemetry (see specialist-execution.ts), so a transient failure
// shouldn't crash the agent loop.
// The shape of `content` varies by activity type. Linear validates
// the inner shape — sending a body-only payload for an "action"
// type (or vice versa) returns a GraphQL error that the
// fire-and-forget caller swallows, so the session panel goes
// silent for every malformed post. Model the shapes here as a
// discriminated union so callers can't construct invalid content.
export type AgentActivityContent =
  | { type: "thought"; body: string }
  | { type: "response"; body: string }
  | { type: "error"; body: string }
  | { type: "elicitation"; body: string }
  | {
      type: "action";
      // Human-readable label for the tool invocation. Linear's
      // sample values are gerund-form like "Searching" /
      // "Searched" — pre-result vs post-result. We don't currently
      // model the in-flight transition; emit the past-tense form
      // alongside `result` in a single post.
      action: string;
      // Stringified input — Linear's docs say plain string, not
      // JSON. Callers serialize.
      parameter: string;
      // Optional completion details, supports Markdown.
      result?: string;
    };

export async function agentActivityCreate(input: {
  accessToken: string;
  agentSessionId: string;
  content: AgentActivityContent;
}): Promise<{ activityId: string | null }> {
  // Linear's AgentActivityCreateInput is { agentSessionId, content }
  // where `content` is a JSONObject whose shape varies by `type`.
  // See https://linear.app/developers/agent-interaction —
  // "Shape of content varies by activity type".
  const data = await linearGraphql<{
    agentActivityCreate: {
      success: boolean;
      agentActivity?: { id: string };
    };
  }>({
    accessToken: input.accessToken,
    query: `
      mutation CreateAgentActivity(
        $agentSessionId: String!
        $content: JSONObject!
      ) {
        agentActivityCreate(input: {
          agentSessionId: $agentSessionId
          content: $content
        }) {
          success
          agentActivity { id }
        }
      }
    `,
    variables: {
      agentSessionId: input.agentSessionId,
      content: input.content,
    },
  });
  return {
    activityId: data.agentActivityCreate.agentActivity?.id ?? null,
  };
}

// Reassigns a Linear issue to a different user. Pass `null` for
// `assigneeId` to un-assign (Linear's API accepts that as a valid
// transition).
export async function reassignIssue(input: {
  accessToken: string;
  issueId: string;
  assigneeId: string | null;
}): Promise<void> {
  const data = await linearGraphql<{ issueUpdate: { success: boolean } }>({
    accessToken: input.accessToken,
    query: `
      mutation Reassign($id: String!, $assigneeId: String) {
        issueUpdate(id: $id, input: { assigneeId: $assigneeId }) {
          success
        }
      }
    `,
    variables: { id: input.issueId, assigneeId: input.assigneeId },
  });
  if (!data.issueUpdate.success) {
    throw new LinearClientError(
      "graphql_error",
      `issueUpdate(reassign) returned success=false for issue ${input.issueId}`,
    );
  }
}
