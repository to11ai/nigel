import { describe, expect, test } from "bun:test";
import type { LinearIssue } from "./event-schema";
import { resolveRepo } from "./repo-resolver";

function makeIssue(overrides: Partial<LinearIssue> = {}): LinearIssue {
  return {
    id: "iss-1",
    identifier: "TEAM-1",
    title: "Test",
    teamId: "team-1",
    ...overrides,
  };
}

describe("resolveRepo — native GitHub attachment", () => {
  test("matches a plain GitHub URL", () => {
    const issue = makeIssue({
      attachments: [{ url: "https://github.com/to11ai/nigel" }],
    });
    expect(resolveRepo({ issue, teamRepoMap: {} })).toBe("to11ai/nigel");
  });

  test("matches a deep GitHub URL (issue / PR / blob)", () => {
    const issue = makeIssue({
      attachments: [
        { url: "https://github.com/to11ai/nigel/pull/42" },
        { url: "https://github.com/to11ai/nigel/issues/5" },
      ],
    });
    expect(resolveRepo({ issue, teamRepoMap: {} })).toBe("to11ai/nigel");
  });

  test("strips a .git suffix", () => {
    const issue = makeIssue({
      attachments: [{ url: "https://github.com/to11ai/nigel.git" }],
    });
    expect(resolveRepo({ issue, teamRepoMap: {} })).toBe("to11ai/nigel");
  });

  test("preserves dots in repo names (vercel/next.js)", () => {
    const issue = makeIssue({
      attachments: [{ url: "https://github.com/vercel/next.js" }],
    });
    expect(resolveRepo({ issue, teamRepoMap: {} })).toBe("vercel/next.js");
  });

  test("dotted repo name + .git suffix peels suffix correctly", () => {
    const issue = makeIssue({
      attachments: [{ url: "https://github.com/socketio/socket.io.git" }],
    });
    expect(resolveRepo({ issue, teamRepoMap: {} })).toBe("socketio/socket.io");
  });

  test("dotted repo name + deep path", () => {
    const issue = makeIssue({
      attachments: [{ url: "https://github.com/vercel/next.js/pull/12345" }],
    });
    expect(resolveRepo({ issue, teamRepoMap: {} })).toBe("vercel/next.js");
  });

  test("reads attachment.metadata.url when top-level url is missing", () => {
    const issue = makeIssue({
      attachments: [
        { metadata: { url: "https://github.com/to11ai/other-repo" } },
      ],
    });
    expect(resolveRepo({ issue, teamRepoMap: {} })).toBe("to11ai/other-repo");
  });

  test("ignores non-github attachments", () => {
    const issue = makeIssue({
      attachments: [
        { url: "https://example.com/some-doc" },
        { url: "https://gitlab.com/owner/repo" },
      ],
    });
    expect(resolveRepo({ issue, teamRepoMap: {} })).toBeNull();
  });
});

describe("resolveRepo — team_repo_map fallback", () => {
  test("uses the team map when no attachment matches", () => {
    const issue = makeIssue({ teamId: "team-platform" });
    expect(
      resolveRepo({
        issue,
        teamRepoMap: { "team-platform": "to11ai/from-map" },
      }),
    ).toBe("to11ai/from-map");
  });

  test("attachment beats team map when both resolve", () => {
    const issue = makeIssue({
      teamId: "team-platform",
      attachments: [{ url: "https://github.com/to11ai/from-attachment" }],
    });
    expect(
      resolveRepo({
        issue,
        teamRepoMap: { "team-platform": "to11ai/from-map" },
      }),
    ).toBe("to11ai/from-attachment");
  });
});

describe("resolveRepo — label fallback", () => {
  test("recognizes `repo:owner/name` labels", () => {
    const issue = makeIssue({
      labels: [{ name: "other-label" }, { name: "repo:to11ai/from-label" }],
    });
    expect(resolveRepo({ issue, teamRepoMap: {} })).toBe("to11ai/from-label");
  });

  test("team map beats label", () => {
    const issue = makeIssue({
      teamId: "team-platform",
      labels: [{ name: "repo:to11ai/from-label" }],
    });
    expect(
      resolveRepo({
        issue,
        teamRepoMap: { "team-platform": "to11ai/from-map" },
      }),
    ).toBe("to11ai/from-map");
  });

  test("ignores malformed labels", () => {
    const issue = makeIssue({
      labels: [{ name: "repo:invalid" }, { name: "repo:" }, { name: "label" }],
    });
    expect(resolveRepo({ issue, teamRepoMap: {} })).toBeNull();
  });
});

describe("resolveRepo — fallthrough", () => {
  test("returns null when nothing resolves", () => {
    expect(resolveRepo({ issue: makeIssue(), teamRepoMap: {} })).toBeNull();
  });
});
