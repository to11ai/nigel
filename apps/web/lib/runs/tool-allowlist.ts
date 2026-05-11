import type { ToolSet } from "ai";

// Maps a spec specialist tool category (e.g. "file") to the underlying
// open-agent tool names that implement it. Categories not in this map
// are silently ignored — they correspond to tools that this PR doesn't
// wire up (e.g. `database:*`, `mcp:pulumi`, `cloud:*`, `linear`,
// `dispatch_specialist`, `screenshot_matrix`).
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
