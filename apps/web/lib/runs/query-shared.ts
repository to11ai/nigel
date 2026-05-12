import type { ToolConnectionScope } from "@/lib/tool-connections";

// Shared utilities for the query-shaped tool callbacks
// (`database-query.ts`, `clickhouse-query.ts`, and Redis-query in
// Phase 5e). Kept tiny on purpose — anything connection-kind-specific
// stays in its own file.

export function scopeAllows(
  scope: ToolConnectionScope,
  specialistName: string,
): boolean {
  if (scope.kind === "global") return true;
  return scope.specialistName === specialistName;
}

export function clampPositive(value: number, cap: number): number {
  if (!Number.isFinite(value) || value <= 0) return cap;
  return Math.min(value, cap);
}

// URL hosts can't be percent-encoded the way path/query components
// can: `encodeURIComponent` mangles IPv6 (`::1` → `%3A%3A1`) and the
// brackets that wrap it. Treat the host as opaque and only normalize
// the IPv6 bracket convention. Named hosts and IPv4 addresses pass
// through unchanged; bare IPv6 gets wrapped in `[...]`.
export function formatHostForUrl(host: string): string {
  if (host.startsWith("[") && host.endsWith("]")) {
    return host;
  }
  // IPv6 addresses contain colons but no dots in the bare form. An
  // IPv4-mapped IPv6 (`::ffff:1.2.3.4`) still contains colons, so the
  // "contains colon" signal is what we want.
  if (host.includes(":")) {
    return `[${host}]`;
  }
  return host;
}
