import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { listRootRunsForUser } from "@/lib/runs/repository";
import type { AgentRun } from "@/lib/runs/types";
import { getServerSession } from "@/lib/session/get-server-session";
import { formatCostUsd, formatDuration, statusBadgeClass } from "./_format";

export const metadata: Metadata = {
  title: "Runs",
  description: "Agent run history.",
};

// Server-rendered list of every root run the calling user owns,
// newest first. A "root" is a run with no parent — every chat /
// Linear / cron trigger spawns one of these, and dispatched children
// inherit its `rootRunId`. We don't paginate on this PR because the
// limit cap (50 by default) keeps the surface bounded; cursor paging
// is wired in the repository for the follow-up infinite-scroll PR.
export default async function RunsPage() {
  const session = await getServerSession();
  if (!session?.user?.id) {
    redirect("/");
  }
  const rows = await listRootRunsForUser({ userId: session.user.id });
  return (
    <div className="mx-auto max-w-5xl space-y-6 px-4 py-8">
      <div>
        <h1 className="text-2xl font-semibold">Runs</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Top-level agent runs you own. Children dispatched by a specialist show
          under the parent&apos;s detail page.
        </p>
      </div>
      {rows.length === 0 ? <EmptyState /> : <RunsTable rows={rows} />}
    </div>
  );
}

function EmptyState() {
  return (
    <div className="rounded-md border border-dashed px-6 py-12 text-center text-sm text-muted-foreground">
      No runs yet. Trigger one from a chat or via a Linear webhook to see it
      here.
    </div>
  );
}

function RunsTable({ rows }: { rows: AgentRun[] }) {
  return (
    <div className="overflow-hidden rounded-md border">
      <table className="w-full text-sm">
        <thead className="bg-muted/50 text-left text-xs uppercase tracking-wide text-muted-foreground">
          <tr>
            <th className="px-3 py-2 font-medium">Specialist</th>
            <th className="px-3 py-2 font-medium">Trigger</th>
            <th className="px-3 py-2 font-medium">Status</th>
            <th className="px-3 py-2 font-medium">Cost</th>
            <th className="px-3 py-2 font-medium">Duration</th>
            <th className="px-3 py-2 font-medium">Started</th>
          </tr>
        </thead>
        <tbody className="divide-y">
          {rows.map((row) => (
            <tr key={row.id} className="hover:bg-muted/30">
              <td className="px-3 py-2">
                <Link
                  href={`/runs/${row.id}`}
                  className="font-mono text-sm hover:underline"
                >
                  {row.specialistId ?? "—"}
                </Link>
              </td>
              <td className="px-3 py-2 text-xs text-muted-foreground">
                {row.triggerSource}
                {row.triggerRef ? ` · ${row.triggerRef}` : ""}
              </td>
              <td className="px-3 py-2">
                <span
                  className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${statusBadgeClass(row.status)}`}
                >
                  {row.status}
                </span>
                {row.blockedReason ? (
                  <span className="ml-2 text-xs text-muted-foreground">
                    {row.blockedReason}
                  </span>
                ) : null}
              </td>
              <td className="px-3 py-2 font-mono text-xs">
                {formatCostUsd(row.costUsdActualMicros)}
                <span className="text-muted-foreground">
                  {" "}
                  / {formatCostUsd(row.budgetUsdCapMicros)}
                </span>
              </td>
              <td className="px-3 py-2 font-mono text-xs">
                {formatDuration(row.startedAt, row.endedAt)}
              </td>
              <td className="px-3 py-2 text-xs text-muted-foreground">
                {row.startedAt ? new Date(row.startedAt).toLocaleString() : "—"}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
