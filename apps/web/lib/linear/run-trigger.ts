// Phase 6 L4: shared runtime helpers used by every Linear-triggered
// run intake — both the assignment-driven webhook path and the
// `/run` comment-command path.
//
// Keeping the prompt formatter and the workflow-start shim here
// prevents the two intake routes from silently diverging (different
// prompts, different workflow modules, etc.) the next time someone
// edits one and misses the other.

// Produce the prompt for the planner from the Linear issue. The
// planner expects a self-contained task instruction; we include the
// issue identifier (e.g. PLAT-123) for traceability and the issue
// title + description verbatim. The planner's own prompt instructs
// it to re-state the task in its own words before decomposing.
export function buildTaskText(
  issue: {
    identifier: string;
    title: string;
    description?: string | null;
    url?: string;
  },
  // Optional user-typed prompt from Linear's session panel
  // (AgentSessionEvent.agentSession.prompt / .comment.body). When
  // present this is the direct instruction the user wants Nigel
  // to follow — surfaced AFTER the ticket body so the planner sees
  // ticket context first, then the live user request. Without
  // threading this through, the prompt is silently dropped and the
  // planner reads only the static ticket title/description.
  agentSessionPrompt?: string | null,
): string {
  const body =
    issue.description && issue.description.trim().length > 0
      ? issue.description.trim()
      : "(no description on the ticket)";
  const lines: string[] = [
    `Linear ticket: ${issue.identifier} — ${issue.title}`,
    ...(issue.url ? [`Source: ${issue.url}`] : []),
    "",
    body,
  ];
  if (agentSessionPrompt && agentSessionPrompt.trim().length > 0) {
    lines.push(
      "",
      "User instructions (from Linear session panel):",
      agentSessionPrompt.trim(),
    );
  }
  return lines.join("\n");
}

// Production starter — dynamic-import to avoid pulling the Workflow
// SDK + the workflow module into the test path. Both intake routes
// (`deps.startWorkflow` injection seam) use this as the default
// when no test stub is supplied.
export async function defaultStartLinearTriggeredWorkflow(input: {
  agentRunId: string;
  taskText: string;
}): Promise<void> {
  const { start } = await import("workflow/api");
  const { runLinearTriggeredWorkflow } =
    await import("@/app/workflows/linear-trigger");
  await start(runLinearTriggeredWorkflow, [input]);
}
