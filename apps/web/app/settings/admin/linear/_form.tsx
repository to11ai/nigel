"use client";

import { Loader2, Plus, Trash2 } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import {
  adminCreateLinearWorkspace,
  type AdminLinearWorkspaceItem,
  adminUpdateLinearWorkspace,
} from "@/lib/admin/linear-actions";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

// Phase 6 L5: single-row config form for /admin/linear. Same UX
// pattern as /admin/tool-connections: kind+name immutable on edit,
// secret fields stay blank ("leave blank to keep, fill to rotate"),
// patch-vs-create branched on whether an `existing` row was passed.
//
// `team_repo_map` is rendered as a list of key/value pairs because
// jsonb-as-textarea is an objectively worse UX. The row state holds
// the map as an array so reordering and partial-blank rows behave
// predictably; conversion to the {linear_team_id → "owner/repo"}
// shape happens at submit time.

type Props = {
  existing: AdminLinearWorkspaceItem | null;
  onSubmitted: () => void | Promise<void>;
};

type TeamRepoEntry = { teamId: string; repo: string };

export function LinearWorkspaceForm({ existing, onSubmitted }: Props) {
  const isEdit = existing != null;
  const [workspaceId, setWorkspaceId] = useState(existing?.workspaceId ?? "");
  const [botUserId, setBotUserId] = useState(existing?.botUserId ?? "");
  const [webhookSecret, setWebhookSecret] = useState("");
  const [accessToken, setAccessToken] = useState("");
  const [teamRepoEntries, setTeamRepoEntries] = useState<TeamRepoEntry[]>(() =>
    entriesFromMap(existing?.teamRepoMap ?? {}),
  );
  const [submitting, setSubmitting] = useState(false);

  function setEntry(index: number, patch: Partial<TeamRepoEntry>) {
    setTeamRepoEntries((rows) =>
      rows.map((r, i) => (i === index ? { ...r, ...patch } : r)),
    );
  }
  function addEntry() {
    setTeamRepoEntries((rows) => [...rows, { teamId: "", repo: "" }]);
  }
  function removeEntry(index: number) {
    setTeamRepoEntries((rows) => rows.filter((_, i) => i !== index));
  }

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    setSubmitting(true);
    try {
      const teamRepoMap = mapFromEntries(teamRepoEntries);
      if (isEdit && existing) {
        const res = await adminUpdateLinearWorkspace({
          id: existing.id,
          botUserId: botUserId.trim(),
          ...(webhookSecret ? { webhookSecret } : {}),
          ...(accessToken ? { accessToken } : {}),
          teamRepoMap,
        });
        if (res.success) {
          toast.success("Linear workspace updated");
          await onSubmitted();
        } else {
          toast.error(res.error);
        }
        return;
      }
      const res = await adminCreateLinearWorkspace({
        workspaceId: workspaceId.trim(),
        botUserId: botUserId.trim(),
        webhookSecret,
        accessToken,
        teamRepoMap,
      });
      if (res.success) {
        toast.success("Linear workspace configured");
        await onSubmitted();
      } else {
        toast.error(res.error);
      }
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form className="space-y-5" onSubmit={handleSubmit}>
      <div className="grid grid-cols-2 gap-3">
        <div className="space-y-1.5">
          <Label htmlFor="workspaceId">Workspace ID</Label>
          <Input
            id="workspaceId"
            value={workspaceId}
            onChange={(e) => setWorkspaceId(e.target.value)}
            placeholder="Linear's workspace UUID"
            disabled={isEdit}
          />
          {isEdit ? (
            <p className="text-xs text-muted-foreground">
              Immutable; delete + recreate to change.
            </p>
          ) : null}
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="botUserId">Bot user ID</Label>
          <Input
            id="botUserId"
            value={botUserId}
            onChange={(e) => setBotUserId(e.target.value)}
            placeholder="The Linear user assignments trigger on"
          />
        </div>
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="webhookSecret">Webhook signing secret</Label>
        <Input
          id="webhookSecret"
          type="password"
          value={webhookSecret}
          onChange={(e) => setWebhookSecret(e.target.value)}
          placeholder={
            isEdit ? "Leave blank to keep current" : "From Linear webhook setup"
          }
        />
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="accessToken">Linear OAuth access token</Label>
        <Input
          id="accessToken"
          type="password"
          value={accessToken}
          onChange={(e) => setAccessToken(e.target.value)}
          placeholder={
            isEdit
              ? "Leave blank to keep current"
              : "For outbound comments + reassignment"
          }
        />
      </div>

      <TeamRepoMapEditor
        entries={teamRepoEntries}
        onSetEntry={setEntry}
        onAddEntry={addEntry}
        onRemoveEntry={removeEntry}
      />

      <div className="flex justify-end gap-2">
        <Button type="submit" disabled={submitting}>
          {submitting ? <Loader2 className="size-4 animate-spin" /> : null}
          {submitting
            ? isEdit
              ? "Saving…"
              : "Configuring…"
            : isEdit
              ? "Save changes"
              : "Configure"}
        </Button>
      </div>
    </form>
  );
}

function TeamRepoMapEditor(props: {
  entries: TeamRepoEntry[];
  onSetEntry: (i: number, patch: Partial<TeamRepoEntry>) => void;
  onAddEntry: () => void;
  onRemoveEntry: (i: number) => void;
}) {
  return (
    <div className="space-y-2 rounded-md border bg-muted/20 p-3">
      <div className="flex items-center justify-between">
        <Label className="text-sm">Team → repo map</Label>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={props.onAddEntry}
        >
          <Plus className="size-4" />
          Add team
        </Button>
      </div>
      <p className="text-xs text-muted-foreground">
        Resolves the repo for a triggered Run when the Linear issue has no
        native GitHub link. Falls back to a <code>repo:owner/name</code> label
        on the issue if neither matches.
      </p>
      {props.entries.length === 0 ? (
        <div className="rounded border border-dashed px-3 py-6 text-center text-xs text-muted-foreground">
          No team mappings. Tickets without a native GitHub link or a label will
          fail repo resolution.
        </div>
      ) : (
        <div className="space-y-2">
          {props.entries.map((entry, i) => (
            <div key={i} className="flex items-center gap-2">
              <Input
                value={entry.teamId}
                onChange={(e) =>
                  props.onSetEntry(i, { teamId: e.target.value })
                }
                placeholder="Linear team ID"
              />
              <span className="text-muted-foreground">→</span>
              <Input
                value={entry.repo}
                onChange={(e) => props.onSetEntry(i, { repo: e.target.value })}
                placeholder="owner/repo"
              />
              <Button
                type="button"
                variant="ghost"
                size="sm"
                aria-label="Remove team mapping"
                onClick={() => props.onRemoveEntry(i)}
              >
                <Trash2 className="size-4 text-red-400" />
              </Button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function entriesFromMap(
  map: Readonly<Record<string, string>>,
): TeamRepoEntry[] {
  return Object.entries(map).map(([teamId, repo]) => ({ teamId, repo }));
}

function mapFromEntries(
  entries: TeamRepoEntry[],
): Readonly<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const entry of entries) {
    const k = entry.teamId.trim();
    const v = entry.repo.trim();
    if (k && v) out[k] = v;
  }
  return out;
}
