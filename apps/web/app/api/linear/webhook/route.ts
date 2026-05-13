import type { NextRequest } from "next/server";
import { handleLinearWebhook } from "@/lib/linear/webhook-handler";

// Phase 6 L2: inbound Linear webhook receiver.
//
// Always returns 200 — even on signature failure, invalid payload,
// unresolved repo/owner, OR unhandled internal exception. Linear
// retries non-2xx deliveries; a retry against a partially-completed
// state (claim row inserted, Run.create threw) would hit the
// idempotency `duplicate` path and permanently lose the event.
// Returning 200 unconditionally + logging the failure + surfacing
// the unprocessed claim row in the operator UI (L5) is the right
// trade-off.
//
// Force Node runtime: the handler reaches into the encryption
// module which relies on `node:crypto`. Edge runtime would also
// work for the HMAC verify but trips on the postgres client when
// we read the workspace row, so we just pin to Node.
export const runtime = "nodejs";

const SIGNATURE_HEADER = "linear-signature";
// Linear's per-delivery UUID — the authoritative idempotency key.
// NOT to be confused with the body field `webhookId`, which is the
// webhook subscription UUID and constant across every event from a
// given endpoint.
const DELIVERY_HEADER = "linear-delivery";
const DEFAULT_BUDGET_MICROS = 5_000_000; // $5

export async function POST(req: NextRequest): Promise<Response> {
  const rawBody = await req.text();
  const signature = req.headers.get(SIGNATURE_HEADER);
  const deliveryHeader = req.headers.get(DELIVERY_HEADER);

  // Parse the default-budget env var here so the handler stays
  // dep-free of process.env (easier to test). Falls back to $5 if
  // unset or invalid.
  const envBudget = process.env.LINEAR_DEFAULT_BUDGET_USD_MICROS;
  const parsedBudget = envBudget ? Number.parseInt(envBudget, 10) : NaN;
  const defaultBudgetUsdMicros =
    Number.isFinite(parsedBudget) && parsedBudget > 0
      ? parsedBudget
      : DEFAULT_BUDGET_MICROS;

  try {
    const outcome = await handleLinearWebhook({
      rawBody,
      signatureHeader: signature,
      deliveryHeader,
      defaultBudgetUsdMicros,
    });
    // Log every outcome at INFO so ops can grep. Sensitive content
    // (raw body, signature) is intentionally NOT logged — the
    // outcome discriminant is enough to triage.
    console.log("[linear-webhook]", outcome);
    return Response.json({ ok: true, outcome }, { status: 200 });
  } catch (err) {
    // The handler's typed outcomes cover every expected branch.
    // This catch is for genuinely unexpected exceptions: DB
    // connection drop, encryption-module bug, etc. Log loudly so
    // ops sees the full detail; return 200 so Linear doesn't retry
    // into a potentially-half-committed state.
    //
    // CRITICAL: the response body is exposed to any unauthenticated
    // caller — the catch wraps the workspace resolve, which runs
    // BEFORE signature verification. Returning `err.message` would
    // leak DB hostnames, "encryption key missing" diagnostics, or
    // other infrastructure details to anyone who can POST here.
    // The full error stays in the server-side log; the wire
    // response gets a static string.
    console.error("[linear-webhook] unhandled exception:", err);
    return Response.json(
      { ok: true, outcome: { kind: "internal_error" } },
      { status: 200 },
    );
  }
}
