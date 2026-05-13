import type { LinearIssue } from "./event-schema";
import type { LinearTeamRepoMap } from "./workspace-repository";

// Phase 6 L2: repo resolution for a Linear-triggered Run.
//
// Spec section 3 (Linear webhook, step 3): resolve repo in three
// fallbacks, in order:
//   1. Linear's native GitHub link on the issue (the `attachments`
//      array, where the integration drops a row whose URL points
//      at the GitHub repo or issue).
//   2. `linear_workspace.team_repo_map[issue.team_id]`.
//   3. A `repo:owner/name` label on the issue.
//
// Returns `null` when none of the three resolve. The caller is
// responsible for surfacing the failure to the admin (Phase L3 adds
// the "no repo mapped" Linear comment + reassignment back to the
// actor); L2 just acknowledges the webhook.

// `repo` is always normalized to `owner/repo` — no trailing slashes,
// no `.git`, no `https://github.com/` prefix. Downstream Run code
// uses this string as the `repoRef` column verbatim.
export type ResolvedRepo = string;

// Looks like `https://github.com/<owner>/<repo>` optionally followed by
// `/...`. Captures owner + repo. Tolerates `.git` suffix and case
// variations. Anchored to start to avoid matching URLs embedded
// inside markdown links.
const GITHUB_URL_REGEX =
  /^https:\/\/github\.com\/([^/\s]+)\/([^/\s.]+)(?:\.git)?(?:\/.*)?$/i;
// `repo:owner/name` label format. Owner / name use the same charset
// GitHub allows (alphanumerics, dashes, underscores, dots). Anchored.
const REPO_LABEL_REGEX = /^repo:([a-z0-9._-]+)\/([a-z0-9._-]+)$/i;

export function resolveRepo(input: {
  issue: LinearIssue;
  teamRepoMap: LinearTeamRepoMap;
}): ResolvedRepo | null {
  return (
    fromNativeAttachment(input.issue) ??
    fromTeamMap(input.issue.teamId, input.teamRepoMap) ??
    fromLabel(input.issue) ??
    null
  );
}

function fromNativeAttachment(issue: LinearIssue): ResolvedRepo | null {
  const attachments = issue.attachments ?? [];
  for (const att of attachments) {
    const url = att.url ?? att.metadata?.url;
    if (typeof url !== "string") continue;
    const match = GITHUB_URL_REGEX.exec(url);
    if (match?.[1] && match[2]) {
      return `${match[1]}/${match[2]}`;
    }
  }
  return null;
}

function fromTeamMap(
  teamId: string,
  map: LinearTeamRepoMap,
): ResolvedRepo | null {
  const value = map[teamId];
  return typeof value === "string" && value.length > 0 ? value : null;
}

function fromLabel(issue: LinearIssue): ResolvedRepo | null {
  const labels = issue.labels ?? [];
  for (const label of labels) {
    const match = REPO_LABEL_REGEX.exec(label.name);
    if (match?.[1] && match[2]) {
      return `${match[1]}/${match[2]}`;
    }
  }
  return null;
}
