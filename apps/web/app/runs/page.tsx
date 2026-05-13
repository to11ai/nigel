import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { getPresetNames } from "@/lib/specialists";
import { listRootRunsForUser } from "@/lib/runs/repository";
import {
  type AgentRun,
  runStatusSchema,
  triggerSourceSchema,
} from "@/lib/runs/types";
import { getServerSession } from "@/lib/session/get-server-session";
import { RunsFilters } from "./_filters";
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
//
// Filter params live in the URL search string (`specialist`, `status`,
// `trigger`, `min_cost`) so a filtered view is shareable and the
// back button works. Invalid values fall through to "no constraint
// from this filter" rather than rejecting — the user-facing UI never
// produces an invalid value, and being lenient on hand-edited URLs
// is friendlier than 404'ing.
type SearchParams = Promise<{
  specialist?: string;
  status?: string;
  trigger?: string;
  min_cost?: string;
}>;

export default async function RunsPage({
  searchParams,
}: {
  searchParams: SearchParams;
}) {
  const session = await getServerSession();
  if (!session?.user?.id) {
    redirect("/");
  }
  const params = await searchParams;
  const filters = parseFilters(params);
  const rows = await listRootRunsForUser({
    userId: session.user.id,
    ...filters,
  });
  const presetNames = getPresetNames();
  return (
    <div className="mx-auto max-w-5xl space-y-6 px-4 py-8">
      <div>
        <h1 className="text-2xl font-semibold">Runs</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Top-level agent runs you own. Children dispatched by a specialist show
          under the parent&apos;s detail page.
        </p>
      </div>
      <RunsFilters
        specialistNames={presetNames}
        statuses={runStatusSchema.options}
        triggerSources={triggerSourceSchema.options}
      />
      {rows.length === 0 ? (
        <EmptyState hasFilters={hasAnyFilter(filters)} />
      ) : (
        <RunsTable rows={rows} />
      )}
    </div>
  );
}

// Coerce the raw URL params into a typed filter object the
// repository accepts. Each param is validated independently —
// invalid values are dropped without error so a hand-edited URL
// degrades gracefully.
function parseFilters(params: Awaited<SearchParams>): {
  specialistId?: string;
  status?: ReturnType<typeof runStatusSchema.parse>;
  triggerSource?: ReturnType<typeof triggerSourceSchema.parse>;
  minCostMicros?: number;
} {
  const out: ReturnType<typeof parseFilters> = {};
  if (params.specialist && params.specialist.length > 0) {
    out.specialistId = params.specialist;
  }
  const statusResult = runStatusSchema.safeParse(params.status);
  if (statusResult.success) out.status = statusResult.data;
  const triggerResult = triggerSourceSchema.safeParse(params.trigger);
  if (triggerResult.success) out.triggerSource = triggerResult.data;
  if (params.min_cost) {
    const usd = Number(params.min_cost);
    if (Number.isFinite(usd) && usd > 0) {
      out.minCostMicros = Math.round(usd * 1_000_000);
    }
  }
  return out;
}

function hasAnyFilter(f: ReturnType<typeof parseFilters>): boolean {
  return (
    f.specialistId !== undefined ||
    f.status !== undefined ||
    f.triggerSource !== undefined ||
    f.minCostMicros !== undefined
  );
}

function EmptyState({ hasFilters }: { hasFilters: boolean }) {
  if (hasFilters) {
    return (
      <div className="rounded-md border border-dashed px-6 py-12 text-center text-sm text-muted-foreground">
        No runs match these filters. Try clearing one or all of them.
      </div>
    );
  }
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
