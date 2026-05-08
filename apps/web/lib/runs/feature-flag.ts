// Phase 1 chat-path gate. Default off; old code path runs unchanged.
// Flip to "1" or "true" to route new chat sessions through Run.create().
export function isRunsEnabled(): boolean {
  const raw = process.env.NIGEL_ENABLE_RUNS;
  if (!raw) {
    return false;
  }
  return raw === "1" || raw.toLowerCase() === "true";
}
