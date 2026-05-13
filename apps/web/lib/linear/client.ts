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
