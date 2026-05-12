// Shared formatters for the /runs pages. Kept tiny — they're only
// used by the list view and the detail view, and inlining them in
// either page would create two slightly-different formatters six
// months from now.

export function formatCostUsd(micros: number): string {
  // Costs are stored in micro-USD (1_000_000 = $1). Two decimal
  // places is enough resolution for the UI; sub-cent precision shows
  // up in the DB if anyone needs to dig deeper.
  const dollars = micros / 1_000_000;
  return `$${dollars.toFixed(2)}`;
}

export function formatDuration(
  startedAt: Date | null,
  endedAt: Date | null,
): string {
  if (!startedAt) return "—";
  const end = endedAt ?? new Date();
  const ms = end.getTime() - new Date(startedAt).getTime();
  if (ms < 0) return "—";
  if (ms < 1000) return `${ms}ms`;
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const remSec = s % 60;
  if (m < 60) return remSec > 0 ? `${m}m ${remSec}s` : `${m}m`;
  const h = Math.floor(m / 60);
  const remMin = m % 60;
  return remMin > 0 ? `${h}h ${remMin}m` : `${h}h`;
}

export function statusBadgeClass(status: string): string {
  switch (status) {
    case "completed":
      return "bg-emerald-500/10 text-emerald-400";
    case "running":
      return "bg-blue-500/10 text-blue-400";
    case "pending":
      return "bg-zinc-500/10 text-zinc-400";
    case "blocked":
      return "bg-amber-500/10 text-amber-400";
    case "awaiting_approval":
      return "bg-amber-500/10 text-amber-400";
    case "failed":
      return "bg-red-500/10 text-red-400";
    case "cancelled":
      return "bg-zinc-500/10 text-zinc-400";
    default:
      return "bg-zinc-500/10 text-zinc-400";
  }
}
