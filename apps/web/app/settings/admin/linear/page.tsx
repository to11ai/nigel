"use client";

import { Loader2, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import {
  adminDeleteLinearWorkspace,
  adminGetLinearWorkspace,
  type AdminLinearWorkspaceItem,
} from "@/lib/admin/linear-actions";
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
import { LinearWorkspaceForm } from "./_form";

// Phase 6 L5: /admin/linear page. Singleton workspace row (one per
// deployment), so the UI is "configured" / "not configured" rather
// than a list. The form does both create and edit; the empty state
// renders it in create mode.

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

function LinearAdminPageContent() {
  const [workspace, setWorkspace] = useState<
    AdminLinearWorkspaceItem | null | undefined
  >(undefined); // undefined = loading, null = unconfigured, value = configured
  const [loadError, setLoadError] = useState<string | null>(null);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);

  async function refresh() {
    const res = await adminGetLinearWorkspace();
    if (res.success) {
      setWorkspace(res.data);
      setLoadError(null);
    } else {
      setLoadError(res.error);
    }
  }

  useEffect(() => {
    refresh();
  }, []);

  async function handleDelete() {
    if (!workspace) return;
    setIsDeleting(true);
    try {
      const res = await adminDeleteLinearWorkspace(workspace.id);
      if (res.success) {
        toast.success("Linear workspace deleted");
        await refresh();
      } else {
        toast.error(res.error);
      }
    } finally {
      setIsDeleting(false);
      setDeleteOpen(false);
    }
  }

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between">
        <div>
          <h1 className="text-2xl font-semibold">Linear workspace</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Configures the inbound Linear webhook + outbound API access. One
            workspace per Nigel deployment. Secrets are encrypted at rest and
            never returned to the UI.
          </p>
        </div>
        {workspace ? (
          <Button
            variant="outline"
            size="sm"
            onClick={() => setDeleteOpen(true)}
          >
            <Trash2 className="size-4 text-red-400" />
            Delete
          </Button>
        ) : null}
      </div>

      {loadError ? (
        <div className="rounded-md border border-red-500/30 bg-red-500/5 px-4 py-3 text-sm text-red-400">
          {loadError}
        </div>
      ) : null}

      {workspace === undefined && !loadError ? (
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="size-4 animate-spin" />
          Loading…
        </div>
      ) : null}

      {workspace !== undefined ? (
        <LinearWorkspaceForm
          existing={workspace}
          onSubmitted={async () => {
            await refresh();
          }}
        />
      ) : null}

      <Dialog
        open={deleteOpen}
        onOpenChange={(open) => {
          if (!open) setDeleteOpen(false);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete Linear workspace config?</DialogTitle>
            <DialogDescription>
              Inbound webhooks will start returning
              <span className="mx-1 font-mono">no_workspace_configured</span>
              and stop creating Runs. Existing Runs are untouched. This action
              cannot be undone.
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
    </div>
  );
}

export default function LinearAdminPage() {
  const { isAdmin, loading } = useSession();
  if (loading) return null;
  if (!isAdmin) return <NotFoundState />;
  return <LinearAdminPageContent />;
}
