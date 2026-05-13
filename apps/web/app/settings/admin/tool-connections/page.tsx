"use client";

import { Loader2, Pencil, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";
// Import directly from `types.ts` rather than the `@/lib/tool-connections`
// barrel: the barrel re-exports the repository, which transitively pulls
// in `postgres` (node-only) and would fail the browser bundle.
import { TOOL_CONNECTION_KINDS } from "@/lib/tool-connections/types";
import { ToolConnectionForm } from "./_form";
import {
  adminDeleteToolConnection,
  adminGetToolConnection,
  adminListToolConnections,
  type ToolConnectionEditItem,
  type ToolConnectionListItem,
} from "@/lib/admin/tool-connections-actions";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useSession } from "@/hooks/use-session";

function NotFoundState() {
  return (
    <div className="flex flex-col items-center justify-center py-24 text-center">
      <p className="text-4xl font-bold">404</p>
      <p className="mt-2 text-sm text-muted-foreground">
        This page could not be found.
      </p>
    </div>
  );
}

function ToolConnectionsPageContent() {
  const [rows, setRows] = useState<ToolConnectionListItem[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [editTarget, setEditTarget] = useState<ToolConnectionEditItem | null>(
    null,
  );
  const [editLoadingId, setEditLoadingId] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] =
    useState<ToolConnectionListItem | null>(null);
  const [isDeleting, setIsDeleting] = useState(false);

  async function refresh() {
    const res = await adminListToolConnections();
    if (res.success) {
      setRows(res.data);
      setLoadError(null);
    } else {
      setLoadError(res.error);
    }
  }

  useEffect(() => {
    refresh();
  }, []);

  async function handleEditClick(row: ToolConnectionListItem) {
    setEditLoadingId(row.id);
    try {
      const res = await adminGetToolConnection(row.id);
      if (res.success) {
        setEditTarget(res.data);
      } else {
        toast.error(res.error);
      }
    } finally {
      setEditLoadingId(null);
    }
  }

  async function handleDelete() {
    if (!deleteTarget) return;
    setIsDeleting(true);
    try {
      const res = await adminDeleteToolConnection(deleteTarget.id);
      if (res.success) {
        toast.success(`Deleted '${deleteTarget.name}'`);
        await refresh();
      } else {
        toast.error(res.error);
      }
    } finally {
      setIsDeleting(false);
      setDeleteTarget(null);
    }
  }

  return (
    <>
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold">Tool connections</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Named credential bundles used by agent tools. Secrets are encrypted
            at rest and never returned to the UI.
          </p>
        </div>
        <Button onClick={() => setCreateOpen(true)}>New connection</Button>
      </div>

      {loadError ? (
        <div className="rounded-md border border-red-500/30 bg-red-500/5 px-4 py-3 text-sm text-red-400">
          {loadError}
        </div>
      ) : null}

      {rows === null && !loadError ? (
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="size-4 animate-spin" />
          Loading…
        </div>
      ) : null}

      {rows !== null && rows.length === 0 ? (
        <div className="rounded-md border border-dashed px-6 py-12 text-center text-sm text-muted-foreground">
          No connections yet. Create one with the button above to wire it into a
          specialist allowlist.
        </div>
      ) : null}

      {rows && rows.length > 0 ? (
        <div className="overflow-hidden rounded-md border">
          <table className="w-full text-sm">
            <thead className="bg-muted/50 text-left text-xs uppercase tracking-wide text-muted-foreground">
              <tr>
                <th className="px-3 py-2 font-medium">Name</th>
                <th className="px-3 py-2 font-medium">Kind</th>
                <th className="px-3 py-2 font-medium">Scope</th>
                <th className="px-3 py-2 font-medium">Description</th>
                <th className="px-3 py-2 font-medium">Updated</th>
                <th className="px-3 py-2 font-medium" />
              </tr>
            </thead>
            <tbody className="divide-y">
              {rows.map((row) => (
                <tr key={row.id} className="hover:bg-muted/30">
                  <td className="px-3 py-2 font-mono">{row.name}</td>
                  <td className="px-3 py-2">{row.kind}</td>
                  <td className="px-3 py-2 font-mono text-xs">{row.scope}</td>
                  <td className="px-3 py-2 text-muted-foreground">
                    {row.description ?? "—"}
                  </td>
                  <td className="px-3 py-2 text-muted-foreground text-xs">
                    {new Date(row.updatedAt).toLocaleString()}
                  </td>
                  <td className="px-3 py-2 text-right">
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => handleEditClick(row)}
                      aria-label={`Edit ${row.name}`}
                      disabled={editLoadingId === row.id}
                    >
                      {editLoadingId === row.id ? (
                        <Loader2 className="size-4 animate-spin" />
                      ) : (
                        <Pencil className="size-4" />
                      )}
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => setDeleteTarget(row)}
                      aria-label={`Delete ${row.name}`}
                    >
                      <Trash2 className="size-4 text-red-400" />
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}

      <Dialog
        open={createOpen}
        onOpenChange={(open) => {
          if (!open) setCreateOpen(false);
        }}
      >
        <DialogContent className="max-w-xl">
          <DialogHeader>
            <DialogTitle>New tool connection</DialogTitle>
            <DialogDescription>
              Pick a kind, fill in the fields, and submit. The secret payload is
              encrypted at rest with the server&apos;s
              <code className="mx-1 rounded bg-muted px-1 font-mono">
                TOOL_CONNECTIONS_ENC_KEY
              </code>
              before being written.
            </DialogDescription>
          </DialogHeader>
          <ToolConnectionForm
            kinds={TOOL_CONNECTION_KINDS}
            onSubmitted={async () => {
              setCreateOpen(false);
              await refresh();
            }}
          />
        </DialogContent>
      </Dialog>

      <Dialog
        open={editTarget !== null}
        onOpenChange={(open) => {
          if (!open) setEditTarget(null);
        }}
      >
        <DialogContent className="max-w-xl">
          <DialogHeader>
            <DialogTitle>
              Edit connection &lsquo;{editTarget?.name}&rsquo;
            </DialogTitle>
            <DialogDescription>
              Kind and name are immutable. Leave any secret field blank to keep
              the existing encrypted value; fill it to rotate.
            </DialogDescription>
          </DialogHeader>
          {editTarget ? (
            <ToolConnectionForm
              kinds={TOOL_CONNECTION_KINDS}
              editing={editTarget}
              onSubmitted={async () => {
                setEditTarget(null);
                await refresh();
              }}
            />
          ) : null}
        </DialogContent>
      </Dialog>

      <Dialog
        open={deleteTarget !== null}
        onOpenChange={(open) => {
          if (!open) setDeleteTarget(null);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              Delete connection &lsquo;{deleteTarget?.name}&rsquo;?
            </DialogTitle>
            <DialogDescription>
              Specialists that reference this connection will start receiving
              <span className="mx-1 font-mono">connection_not_resolvable</span>
              errors. This action cannot be undone.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <DialogClose asChild>
              <Button variant="outline" disabled={isDeleting}>
                Cancel
              </Button>
            </DialogClose>
            <Button
              variant="destructive"
              onClick={handleDelete}
              disabled={isDeleting}
            >
              {isDeleting ? <Loader2 className="size-4 animate-spin" /> : null}
              {isDeleting ? "Deleting…" : "Delete"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

export default function ToolConnectionsPage() {
  const { isAdmin, loading } = useSession();
  if (loading) return null;
  if (!isAdmin) return <NotFoundState />;
  return <ToolConnectionsPageContent />;
}
