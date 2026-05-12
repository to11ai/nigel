import type { ToolSet } from "ai";

// Maps a spec specialist tool category (e.g. "file") to the underlying
// open-agent tool names that implement it. Categories not in this map
// are silently ignored — they correspond to tools that this PR doesn't
// wire up (e.g. `database:*`, `mcp:pulumi`, `cloud:*`, `linear`,
// `screenshot_matrix`).
const CATEGORY_TO_TOOLS: Record<string, readonly string[]> = {
  file: ["read", "write", "edit"],
  // Read-only file access for review/audit specialists. The spec calls
  // these "file (read-only)" but the in-code category gets its own name
  // so the runtime can enforce the constraint via the allowlist rather
  // than trusting the system prompt.
  file_read: ["read"],
  search: ["grep", "glob"],
  shell: ["bash"],
  // Until a structured git tool exists, the agent uses bash for git ops.
  git: ["bash"],
  web: ["web_fetch"],
  // Recursion gate — only specialists with `may_recurse: true` (e.g.
  // `planner`) should include this category. dispatch.ts also enforces
  // may_recurse at runtime; the allowlist is the first line of defense.
  dispatch_specialist: ["dispatch_specialist"],
  // SQL against a registered tool_connection of kind 'postgres'. The
  // tool callback enforces scope + read-only at runtime; the
  // allowlist is the first gate.
  database_query: ["database_query"],
  // ClickHouse equivalent. Different SQL dialect + HTTP transport, so
  // it's a separate tool, but same scope + read-only enforcement
  // pattern.
  clickhouse_query: ["clickhouse_query"],
  // Redis is command-shaped rather than query-shaped, so it's a
  // separate tool with a command-allowlist read-only model.
  redis_command: ["redis_command"],
};

export function filterAgentTools<T extends ToolSet>(
  allowlist: readonly string[],
  tools: T,
): Partial<T> {
  const wantedNames = new Set<string>();
  for (const category of allowlist) {
    const expansion = CATEGORY_TO_TOOLS[category];
    if (!expansion) continue;
    for (const name of expansion) wantedNames.add(name);
  }
  const out: Partial<T> = {};
  for (const name of wantedNames) {
    if (name in tools) {
      (out as Record<string, unknown>)[name] = tools[name as keyof T];
    }
  }
  return out;
}
