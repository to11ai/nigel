import type { LinearAgentToolCallback } from "@nigel/agent";
import {
  attachToIssue,
  commentOnIssue,
  fetchIssueByIdentifier,
  fetchIssueForAgent,
  LinearClientError,
} from "./client";
import {
  resolveLinearWorkspace as defaultResolveLinearWorkspace,
  type ResolvedLinearWorkspace,
} from "./workspace-repository";

// Server-side runtime implementation of the three Linear-touching
// tools the planner specialist gets (`linear_get_issue`,
// `linear_comment`, `linear_attach`). The agent-side wrappers in
// `packages/agent/tools/linear.ts` are deliberately ignorant of
// Linear's GraphQL schema, OAuth flow, and workspace resolution —
// they call into this adapter via a callback object stashed on
// `experimental_context.linear`.
//
// Construction (`buildForRun`) is synchronous: it stamps the run
// identifiers on a closure and returns the callback shape. The
// first actual tool invocation resolves the Linear workspace row
// lazily and caches it for the rest of the Run. This matters
// because `specialist-execution.ts` may build the callback for any
// Run regardless of whether that Run will actually use Linear —
// throwing at construction time would force every Run on a
// deployment without Linear to fail-fast, even the ones that never
// would have called a Linear tool.

// Linear's GraphQL ID format. The published examples we've inspected
// are standard UUID v4s; we accept the canonical 8-4-4-4-12 hex
// shape (case-insensitive). Anything that doesn't match this and
// doesn't look like a team-prefixed shorthand is rejected before
// the network call as `invalid_issue_identifier`.
const UUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Linear team-prefixed shorthand, e.g. `LIN-123` / `ENG-7` /
// `eng-12` (case-insensitive on the prefix; digits on the right
// are required). This is how Linear renders issues in tickets,
// comments, commit messages, and the URL bar — the LLM will see
// and write these constantly, so the adapter accepts them
// transparently and resolves to the GraphQL ID server-side.
const SHORTHAND_REGEX = /^([A-Za-z]+)-(\d+)$/;

export type BuildForRunInput = {
  runId: string;
  orgId: string;
  // DI seam for tests. Mirrors the pattern used by
  // `executeSpecialistViaLLM` so the same test harness can stub
  // the workspace resolver here without monkey-patching modules.
  deps?: {
    resolveLinearWorkspace?: () => Promise<ResolvedLinearWorkspace | null>;
  };
};

// Constructor — captures the run identifiers, returns the callback
// shape. Does NOT call `resolveLinearWorkspace` here; the first
// tool invocation does that lazily.
export function buildForRun(input: BuildForRunInput): LinearAgentToolCallback {
  const resolveWorkspace =
    input.deps?.resolveLinearWorkspace ?? defaultResolveLinearWorkspace;

  // `undefined` = not yet attempted; `null` = attempted, no workspace
  // configured (so subsequent calls return `not_configured` without
  // hitting the DB again). We cache the negative result too — if
  // the org genuinely has no Linear row, a noisy agent making N
  // Linear calls in a Run shouldn't trigger N table reads.
  let cachedWorkspace: ResolvedLinearWorkspace | null | undefined;

  // Shorthand → GraphQL ID lookup cache. Linear's
  // `issueByIdentifier` query is one extra round-trip per first
  // use of a shorthand; caching for the Run lifetime means a
  // planner that touches the same issue across `getIssue` +
  // `comment` + `attach` only pays the resolver once.
  const idResolutionCache = new Map<string, string>();

  async function getWorkspaceOrNotConfigured(): Promise<ResolvedLinearWorkspace | null> {
    if (cachedWorkspace === undefined) {
      try {
        cachedWorkspace = (await resolveWorkspace()) ?? null;
      } catch (err) {
        // biome-ignore lint/suspicious/noConsole: ops signal — token resolution failure
        console.error(
          `[linear-agent-tool] resolveLinearWorkspace failed for run ${input.runId}`,
          err,
        );
        cachedWorkspace = null;
      }
    }
    return cachedWorkspace;
  }

  // Normalizes a raw `issueId` (either Linear shorthand `LIN-123`
  // or a Linear GraphQL ID) to the GraphQL ID Linear's mutations
  // require. Throws `invalid_issue_identifier` for empty /
  // malformed inputs BEFORE issuing any network call, so the
  // agent can react without burning tokens on a Linear round-trip
  // that was always going to 4xx.
  async function normalizeIssueId(
    issueId: string,
    accessToken: string,
  ): Promise<string> {
    if (typeof issueId !== "string" || issueId.length === 0) {
      throw new LinearClientError(
        "invalid_issue_identifier",
        `Linear issueId is empty or non-string: ${JSON.stringify(issueId)}`,
      );
    }
    if (UUID_REGEX.test(issueId)) {
      return issueId;
    }
    const shorthandMatch = issueId.match(SHORTHAND_REGEX);
    if (!shorthandMatch) {
      throw new LinearClientError(
        "invalid_issue_identifier",
        `Linear issueId is neither a GraphQL ID (UUID) nor a team-prefixed shorthand (e.g. 'LIN-123'): ${issueId}`,
      );
    }
    const cached = idResolutionCache.get(issueId);
    if (cached !== undefined) return cached;

    // `shorthandMatch` is guaranteed to have indices 1 and 2 by
    // the regex's two capture groups, but TS narrows them as
    // optional. Linear's `team` field is case-sensitive in the
    // dashboard but `issueByIdentifier` accepts lowercase — we
    // pass through whatever the agent supplied to maximize
    // compatibility. Tests cover both upper- and lower-case
    // prefixes.
    const teamKey = shorthandMatch[1] ?? "";
    const issueNumber = Number.parseInt(shorthandMatch[2] ?? "", 10);
    if (!teamKey || !Number.isFinite(issueNumber)) {
      throw new LinearClientError(
        "invalid_issue_identifier",
        `Linear shorthand failed to parse into (team, number): ${issueId}`,
      );
    }

    const resolved = await fetchIssueByIdentifier({
      accessToken,
      teamKey,
      issueNumber,
    });
    if (!resolved) {
      // Cache miss on Linear's side — the team/number combination
      // doesn't correspond to an actual issue. Surface as a
      // typed error rather than letting the next `issue(id:)` /
      // `commentCreate` call generate a confusing "no data" /
      // "success=false" downstream.
      throw new LinearClientError(
        "missing_data",
        `Linear issue not found by identifier: ${issueId}`,
      );
    }
    idResolutionCache.set(issueId, resolved.id);
    return resolved.id;
  }

  const getIssue: LinearAgentToolCallback["getIssue"] = async ({ issueId }) => {
    const workspace = await getWorkspaceOrNotConfigured();
    if (!workspace) return { kind: "not_configured" };
    const accessToken = workspace.secrets.accessToken;
    const normalizedId = await normalizeIssueId(issueId, accessToken);
    const issue = await fetchIssueForAgent({
      accessToken,
      issueId: normalizedId,
    });
    if (!issue) {
      throw new LinearClientError(
        "missing_data",
        `Linear issue not found: ${issueId}`,
      );
    }
    return issue;
  };

  const comment: LinearAgentToolCallback["comment"] = async ({
    issueId,
    body,
  }) => {
    const workspace = await getWorkspaceOrNotConfigured();
    if (!workspace) return { kind: "not_configured" };
    const accessToken = workspace.secrets.accessToken;
    const normalizedId = await normalizeIssueId(issueId, accessToken);
    const result = await commentOnIssue({
      accessToken,
      issueId: normalizedId,
      body,
    });
    return {
      commentId: result.commentId,
      // The mutation payload includes `url` directly when Linear
      // populates it. If it didn't (shouldn't happen in practice,
      // but the GraphQL schema marks it nullable), fall back to
      // an empty string rather than synthesizing a guess —
      // synthesizing would risk handing the agent a URL that
      // doesn't actually navigate to the comment, which is
      // worse than telling the agent it doesn't have one.
      url: result.url ?? "",
    };
  };

  const attach: LinearAgentToolCallback["attach"] = async ({
    issueId,
    url,
    title,
    subtitle,
  }) => {
    const workspace = await getWorkspaceOrNotConfigured();
    if (!workspace) return { kind: "not_configured" };
    const accessToken = workspace.secrets.accessToken;
    const normalizedId = await normalizeIssueId(issueId, accessToken);
    return attachToIssue({
      accessToken,
      issueId: normalizedId,
      url,
      title,
      // `attachToIssue` accepts `subtitle?: string`. Spread the
      // optional through so omitted-on-input stays omitted on the
      // wire — the underlying GraphQL variable is nullable and
      // we don't want to coerce `undefined` to `null`
      // accidentally.
      ...(subtitle !== undefined ? { subtitle } : {}),
    });
  };

  return { getIssue, comment, attach };
}
