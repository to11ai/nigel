// Phase 6 L4: parse a Linear comment body for a Nigel slash-command.
//
// Conventions:
//   - The command must be the FIRST non-empty line of the body.
//     This avoids false matches in long discussion threads that
//     mention "/approve" in prose.
//   - Leading whitespace is tolerated.
//   - Case-insensitive: "/Approve" and "/APPROVE" both match.
//   - An optional argument is the remainder of the same line,
//     trimmed. Used by `/reject` and `/resume` for a reason / note.
//
// Unknown slash-words ("/foo") return null so the handler can
// surface them as "unknown command" rather than silently ignoring;
// the regex itself only ever matches the registered command set so
// the handler doesn't need to re-validate.

export type LinearCommand = "approve" | "reject" | "resume" | "cancel" | "run";

const COMMAND_PATTERN = /^\s*\/(approve|reject|resume|cancel|run)\b\s*(.*)$/i;

export type ParsedCommand = {
  command: LinearCommand;
  // Optional argument — the rest of the command line, trimmed.
  // Empty string when no argument was supplied. Callers decide
  // whether the absence of an argument is acceptable per-command.
  arg: string;
};

export function parseLinearCommand(body: string): ParsedCommand | null {
  // Take the first non-empty line. Linear delivers bodies as raw
  // Markdown so \r\n is possible from Windows clients.
  const lines = body.split(/\r?\n/);
  const firstLine = lines.find((line) => line.trim().length > 0);
  if (!firstLine) return null;
  const match = COMMAND_PATTERN.exec(firstLine);
  if (!match?.[1]) return null;
  const command = match[1].toLowerCase() as LinearCommand;
  const arg = (match[2] ?? "").trim();
  return { command, arg };
}
