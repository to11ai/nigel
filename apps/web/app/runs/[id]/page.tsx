import type { Metadata } from "next";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { getRun, listRunTreeForUser } from "@/lib/runs/repository";
import type { AgentRun } from "@/lib/runs/types";
import { getServerSession } from "@/lib/session/get-server-session";
import { formatCostUsd, formatDuration, statusBadgeClass } from "../_format";

type Props = { params: Promise<{ id: string }> };

export const metadata: Metadata = {
  title: "Run",
  description: "Agent run detail.",
};

// Detail view for a single run. Shows the run's metadata, then a
// depth-indented tree of the rest of the run tree it belongs to —
// either its descendants if this page is the root, or all of its
// siblings/ancestors if the user landed on a child. The tree is
// built from a flat list (one DB round-trip) and assembled
// client-side, depth-first.
export default async function RunDetailPage(props: Props) {
  const { id } = await props.params;
  const session = await getServerSession();
  if (!session?.user?.id) redirect("/");

  const run = await getRun(id);
  if (!run || run.humanOwnerId !== session.user.id) {
    notFound();
  }

  const tree = await listRunTreeForUser({
    rootRunId: run.rootRunId,
    userId: session.user.id,
  });

  return (
    <div className="mx-auto max-w-5xl space-y-6 px-4 py-8">
      <div>
        <Link
          href="/runs"
          className="text-xs text-muted-foreground hover:underline"
        >
          ← All runs
        </Link>
        <h1 className="mt-2 text-2xl font-semibold">
          {run.specialistId ?? "Unnamed run"}
        </h1>
        <p className="mt-1 font-mono text-xs text-muted-foreground">{run.id}</p>
      </div>

      <Metadata run={run} />

      {run.blockedReason ? (
        <div className="rounded-md border border-amber-500/30 bg-amber-500/5 px-4 py-3 text-sm text-amber-400">
          Blocked: {run.blockedReason}
        </div>
      ) : null}

      <div className="space-y-2">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
          Run tree
        </h2>
        <RunTree rows={tree} highlightId={run.id} />
      </div>
    </div>
  );
}

function Metadata({ run }: { run: AgentRun }) {
  return (
    <dl className="grid grid-cols-2 gap-x-4 gap-y-2 rounded-md border bg-muted/20 px-4 py-3 text-sm">
      <dt className="text-muted-foreground">Status</dt>
      <dd>
        <span
          className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${statusBadgeClass(run.status)}`}
        >
          {run.status}
        </span>
      </dd>
      <dt className="text-muted-foreground">Trigger</dt>
      <dd className="font-mono text-xs">
        {run.triggerSource}
        {run.triggerRef ? ` · ${run.triggerRef}` : ""}
      </dd>
      <dt className="text-muted-foreground">Depth</dt>
      <dd className="font-mono text-xs">{run.depth}</dd>
      <dt className="text-muted-foreground">Sandbox policy</dt>
      <dd className="font-mono text-xs">{run.sandboxPolicy}</dd>
      <dt className="text-muted-foreground">Cost / budget</dt>
      <dd className="font-mono text-xs">
        {formatCostUsd(run.costUsdActualMicros)}
        <span className="text-muted-foreground">
          {" "}
          / {formatCostUsd(run.budgetUsdCapMicros)}
        </span>
      </dd>
      <dt className="text-muted-foreground">Duration</dt>
      <dd className="font-mono text-xs">
        {formatDuration(run.startedAt, run.endedAt)}
      </dd>
      <dt className="text-muted-foreground">Started</dt>
      <dd className="font-mono text-xs">
        {run.startedAt ? new Date(run.startedAt).toLocaleString() : "—"}
      </dd>
      <dt className="text-muted-foreground">Ended</dt>
      <dd className="font-mono text-xs">
        {run.endedAt ? new Date(run.endedAt).toLocaleString() : "—"}
      </dd>
      {run.repoRef ? (
        <>
          <dt className="text-muted-foreground">Repo</dt>
          <dd className="font-mono text-xs">{run.repoRef}</dd>
        </>
      ) : null}
      {run.parentRunId ? (
        <>
          <dt className="text-muted-foreground">Parent</dt>
          <dd className="font-mono text-xs">
            <Link href={`/runs/${run.parentRunId}`} className="hover:underline">
              {run.parentRunId}
            </Link>
          </dd>
        </>
      ) : null}
    </dl>
  );
}

type TreeNode = AgentRun & { children: TreeNode[] };

function RunTree({
  rows,
  highlightId,
}: {
  rows: AgentRun[];
  highlightId: string;
}) {
  const byId = new Map<string, TreeNode>();
  for (const r of rows) byId.set(r.id, { ...r, children: [] });
  let root: TreeNode | null = null;
  for (const r of rows) {
    const node = byId.get(r.id)!;
    if (r.parentRunId && byId.has(r.parentRunId)) {
      byId.get(r.parentRunId)!.children.push(node);
    } else {
      root = node;
    }
  }
  // Order each branch's children by createdAt (the SELECT already
  // returned rows in that order; this is defensive in case the
  // ordering changes later).
  for (const node of byId.values()) {
    node.children.sort(
      (a, b) =>
        new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime(),
    );
  }
  if (!root) {
    return (
      <p className="text-sm text-muted-foreground">
        No tree available — this run was not linked into a tree.
      </p>
    );
  }
  return (
    <ul className="space-y-1 rounded-md border bg-muted/10 p-3">
      <TreeNodeView node={root} depth={0} highlightId={highlightId} />
    </ul>
  );
}

function TreeNodeView({
  node,
  depth,
  highlightId,
}: {
  node: TreeNode;
  depth: number;
  highlightId: string;
}) {
  const isHighlight = node.id === highlightId;
  return (
    <>
      <li
        className={`flex items-center gap-3 rounded px-2 py-1 ${isHighlight ? "bg-blue-500/10" : ""}`}
        style={{ paddingLeft: `${depth * 16 + 8}px` }}
      >
        <span className="font-mono text-xs">{node.specialistId ?? "—"}</span>
        <span
          className={`inline-flex items-center rounded-full px-1.5 py-0.5 text-[10px] font-medium ${statusBadgeClass(node.status)}`}
        >
          {node.status}
        </span>
        <span className="font-mono text-[10px] text-muted-foreground">
          {formatCostUsd(node.costUsdActualMicros)}
        </span>
        <span className="font-mono text-[10px] text-muted-foreground">
          {formatDuration(node.startedAt, node.endedAt)}
        </span>
        {isHighlight ? (
          <span className="text-[10px] uppercase tracking-wide text-blue-400">
            this run
          </span>
        ) : (
          <Link
            href={`/runs/${node.id}`}
            className="text-[10px] text-muted-foreground hover:underline"
          >
            view
          </Link>
        )}
      </li>
      {node.children.map((child) => (
        <TreeNodeView
          key={child.id}
          node={child}
          depth={depth + 1}
          highlightId={highlightId}
        />
      ))}
    </>
  );
}
