import type { SlackPostCallback } from "@nigel/agent";
import {
  type ResolvedConnection,
  type SlackConnectionConfig,
  type SlackConnectionSecrets,
  resolveToolConnection,
} from "@/lib/tool-connections";
import { scopeAllows } from "./query-shared";

// Production wiring for the `slack_post` tool: resolve the registered
// Slack incoming-webhook connection, POST a JSON payload to the
// webhook URL, and return Slack's success/failure verdict. There is
// no read-only enforcement layer because Slack incoming webhooks are
// inherently write-only — posting is the only operation they expose.

export class SlackPostError extends Error {
  readonly code:
    | "connection_not_resolvable"
    | "wrong_kind"
    | "scope_denied"
    | "execution_failed";
  constructor(
    code:
      | "connection_not_resolvable"
      | "wrong_kind"
      | "scope_denied"
      | "execution_failed",
    message: string,
  ) {
    super(message);
    this.name = "SlackPostError";
    this.code = code;
  }
}

// Slack webhooks reject payloads larger than 40KB. Cap the POST body
// well below that so a runaway specialist can't generate a giant
// payload and rack up a slow rejection per call. The cap counts the
// serialized JSON body in bytes.
const MAX_BODY_BYTES = 32_768;
// Slack's incoming webhook endpoint typically responds in <1s; cap at
// 15s to bound the worst case (network blips, regional outages) so a
// hung POST can't stall a specialist run.
const REQUEST_TIMEOUT_MS = 15_000;

export type CreateSlackPostCallbackInput = {
  specialistName: string;
};

export function createSlackPostCallback(
  input: CreateSlackPostCallbackInput,
): SlackPostCallback {
  return async (call) => {
    const resolved = await tryResolveConnection(call.connectionName);
    if (resolved.kind !== "slack") {
      throw new SlackPostError(
        "wrong_kind",
        `connection '${call.connectionName}' is kind '${resolved.kind}', not 'slack'`,
      );
    }
    if (!scopeAllows(resolved.scope, input.specialistName)) {
      throw new SlackPostError(
        "scope_denied",
        `connection '${call.connectionName}' is not in scope for specialist '${input.specialistName}'`,
      );
    }
    return postMessage({
      config: resolved.config,
      secrets: resolved.secrets,
      text: call.text,
      ...(call.blocks !== undefined ? { blocks: call.blocks } : {}),
      ...(call.usernameOverride !== undefined
        ? { usernameOverride: call.usernameOverride }
        : {}),
    });
  };
}

async function tryResolveConnection(name: string): Promise<ResolvedConnection> {
  try {
    return await resolveToolConnection(name);
  } catch (err) {
    throw new SlackPostError(
      "connection_not_resolvable",
      err instanceof Error ? err.message : String(err),
    );
  }
}

async function postMessage(input: {
  config: SlackConnectionConfig;
  secrets: SlackConnectionSecrets;
  text: string;
  blocks?: ReadonlyArray<Record<string, unknown>>;
  usernameOverride?: string;
}): Promise<{ ok: boolean; channel?: string }> {
  // Username override precedence: per-call override beats the
  // connection-level default. Empty connection-level `username` (the
  // field is optional) is treated as "use the webhook's own default",
  // which means we omit the field entirely from the payload.
  const username = input.usernameOverride ?? input.config.username;
  const body: Record<string, unknown> = { text: input.text };
  if (input.blocks !== undefined) {
    body.blocks = input.blocks;
  }
  if (username !== undefined) {
    body.username = username;
  }
  const serialized = JSON.stringify(body);
  const byteLength = Buffer.byteLength(serialized, "utf8");
  if (byteLength > MAX_BODY_BYTES) {
    throw new SlackPostError(
      "execution_failed",
      `slack payload is ${byteLength} bytes; cap is ${MAX_BODY_BYTES}. Trim 'text' or 'blocks'.`,
    );
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(input.secrets.webhookUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: serialized,
      signal: controller.signal,
    });
    // Slack incoming webhooks reply with `200 OK` and the literal
    // body `"ok"` on success, or a 4xx with a short error string
    // (`invalid_payload`, `channel_not_found`, etc.) on failure.
    const responseText = await res.text();
    if (!res.ok) {
      throw new SlackPostError(
        "execution_failed",
        `slack webhook responded ${res.status}: ${responseText.slice(0, 200)}`,
      );
    }
    // The `channel` field in config is informational (webhook URL is
    // channel-locked), but surfacing it in the result lets the LLM
    // confirm where the message landed without re-resolving the
    // connection.
    return {
      ok: responseText.trim() === "ok",
      ...(input.config.channel !== undefined
        ? { channel: input.config.channel }
        : {}),
    };
  } catch (err) {
    if (err instanceof SlackPostError) throw err;
    // AbortError surfaces as a DOMException-shaped object with
    // `name === "AbortError"` in undici (Node 18+/Vercel); rewrap it
    // with our own error class so the caller doesn't have to special-
    // case the transport.
    if (
      err instanceof Error &&
      (err.name === "AbortError" || err.name === "TimeoutError")
    ) {
      throw new SlackPostError(
        "execution_failed",
        `slack webhook POST timed out after ${REQUEST_TIMEOUT_MS}ms`,
      );
    }
    throw new SlackPostError(
      "execution_failed",
      err instanceof Error ? err.message : String(err),
    );
  } finally {
    clearTimeout(timer);
  }
}
