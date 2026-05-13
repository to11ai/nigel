"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { useTransition } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

// Filter strip for the /runs index. State lives entirely in URL
// search params so a filtered view is shareable and the back button
// works. The server page reads the same params on render — this
// component just rewrites them.

type Props = {
  specialistNames: readonly string[];
  statuses: readonly string[];
  triggerSources: readonly string[];
};

const STATUS_ANY = "__any";
const SPEC_ANY = "__any";
const TRIGGER_ANY = "__any";

export function RunsFilters({
  specialistNames,
  statuses,
  triggerSources,
}: Props) {
  const router = useRouter();
  const params = useSearchParams();
  const [isPending, startTransition] = useTransition();

  const specialist = params.get("specialist") ?? "";
  const status = params.get("status") ?? "";
  const triggerSource = params.get("trigger") ?? "";
  const minCost = params.get("min_cost") ?? "";

  function setParam(name: string, value: string | null) {
    const next = new URLSearchParams(params.toString());
    if (value === null || value === "") {
      next.delete(name);
    } else {
      next.set(name, value);
    }
    // Drop any cursor when filters change — old cursors refer to the
    // unfiltered page and would skip rows the new filter should show.
    next.delete("before");
    const qs = next.toString();
    startTransition(() => {
      router.replace(qs ? `/runs?${qs}` : "/runs");
    });
  }

  function clearAll() {
    startTransition(() => {
      router.replace("/runs");
    });
  }

  const hasFilters =
    specialist !== "" ||
    status !== "" ||
    triggerSource !== "" ||
    minCost !== "";

  return (
    <div className="flex flex-wrap items-end gap-3 rounded-md border bg-muted/20 p-3">
      <div className="space-y-1.5">
        <Label htmlFor="f-specialist" className="text-xs">
          Specialist
        </Label>
        <Select
          value={specialist === "" ? SPEC_ANY : specialist}
          onValueChange={(v) =>
            setParam("specialist", v === SPEC_ANY ? null : v)
          }
        >
          <SelectTrigger id="f-specialist" className="min-w-[10rem]">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={SPEC_ANY}>Any specialist</SelectItem>
            {specialistNames.map((n) => (
              <SelectItem key={n} value={n}>
                {n}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="f-status" className="text-xs">
          Status
        </Label>
        <Select
          value={status === "" ? STATUS_ANY : status}
          onValueChange={(v) => setParam("status", v === STATUS_ANY ? null : v)}
        >
          <SelectTrigger id="f-status" className="min-w-[8rem]">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={STATUS_ANY}>Any status</SelectItem>
            {statuses.map((s) => (
              <SelectItem key={s} value={s}>
                {s}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="f-trigger" className="text-xs">
          Trigger
        </Label>
        <Select
          value={triggerSource === "" ? TRIGGER_ANY : triggerSource}
          onValueChange={(v) =>
            setParam("trigger", v === TRIGGER_ANY ? null : v)
          }
        >
          <SelectTrigger id="f-trigger" className="min-w-[8rem]">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={TRIGGER_ANY}>Any trigger</SelectItem>
            {triggerSources.map((s) => (
              <SelectItem key={s} value={s}>
                {s}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="f-min-cost" className="text-xs">
          Min cost (USD)
        </Label>
        <Input
          // `defaultValue` only seeds the DOM at mount. Without the
          // key, "Clear filters" or browser back/forward leaves the
          // input visually showing the old number even though the
          // URL has no `min_cost`, and a subsequent blur silently
          // re-applies the cleared filter. Keying on the URL value
          // forces React to remount the input whenever the param
          // changes, syncing the DOM state with the source of truth.
          key={minCost}
          id="f-min-cost"
          type="number"
          inputMode="decimal"
          min={0}
          step="0.01"
          placeholder="0.00"
          className="w-28"
          defaultValue={minCost}
          // onBlur instead of onChange so the URL doesn't churn on
          // every keystroke. Filter applies when the user leaves the
          // field or presses Enter.
          onBlur={(e) => {
            const raw = e.currentTarget.value.trim();
            setParam("min_cost", raw === "" ? null : raw);
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.currentTarget.blur();
            }
          }}
        />
      </div>
      {hasFilters ? (
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={clearAll}
          disabled={isPending}
        >
          Clear filters
        </Button>
      ) : null}
    </div>
  );
}
