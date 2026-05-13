import type { NextRequest } from "next/server";
import { handleLinearWebhook } from "@/lib/linear/webhook-handler";

// Phase 6 L2: inbound Linear webhook receiver.
//
// Always returns 200 — even on signature failure, invalid payload,
// or unresolved repo/owner. Linear retries failed deliveries; we
// don't want it pounding the endpoint on our config bugs. The
// handler's `outcome` discriminant is what surfaces the reason
// (logged here, eventually surfaced to admins via /admin/linear in
// L5).
//
// Status 200 + outcome envelope is the contract we test against;
// the body shape is informational for ops, not consumed by Linear.
//
// Force Node runtime: the handler reaches into the encryption
// module which relies on `node:crypto`. Edge runtime would also
// work for the HMAC verify but trips on the postgres client when
// we read the workspace row, so we just pin to Node.
export const runtime = "nodejs";

const SIGNATURE_HEADER = "linear-signature";
const DEFAULT_BUDGET_MICROS = 5_000_000; // $5

export async function POST(req: NextRequest): Promise<Response> {
  const rawBody = await req.text();
  const signature = req.headers.get(SIGNATURE_HEADER);

  // Parse the default-budget env var here so the handler stays
  // dep-free of process.env (easier to test). Falls back to $5 if
  // unset or invalid.
  const envBudget = process.env.LINEAR_DEFAULT_BUDGET_USD_MICROS;
  const parsedBudget = envBudget ? Number.parseInt(envBudget, 10) : NaN;
  const defaultBudgetUsdMicros =
    Number.isFinite(parsedBudget) && parsedBudget > 0
      ? parsedBudget
      : DEFAULT_BUDGET_MICROS;

  const outcome = await handleLinearWebhook({
    rawBody,
    signatureHeader: signature,
    defaultBudgetUsdMicros,
  });

  // Log every outcome at INFO so ops can grep. Sensitive content
  // (raw body, signature) is intentionally NOT logged — the outcome
  // discriminant is enough to triage.
  console.log("[linear-webhook]", outcome);

  return Response.json({ ok: true, outcome }, { status: 200 });
}
