// Per-million-tokens USD prices for each AI Gateway model slug. Keep this
// flat — pricing changes ship via a deploy. Add slugs as new models are
// onboarded; never remove a slug without first verifying nothing in
// agent_runs references it.
export const PRICING: Record<
  string,
  { in: number; out: number; cacheRead: number }
> = {
  // Vercel AI Gateway model slugs use dots ('claude-sonnet-4.6'), not
  // dashes. The rest of the codebase (chat tests, model variants, prefs)
  // also uses the dot form. Keep these keys in sync with the slugs that
  // `gateway()` is called with — `getProviderOptionsForModel` in
  // packages/agent/models.ts only matches the dot form when deciding
  // adaptive vs. legacy thinking settings.
  "anthropic/claude-opus-4.7": { in: 15, out: 75, cacheRead: 1.5 },
  "anthropic/claude-sonnet-4.6": { in: 3, out: 15, cacheRead: 0.3 },
  "anthropic/claude-haiku-4.5": { in: 0.8, out: 4, cacheRead: 0.08 },
};

export type TokenUsage = {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
};

// Cost in micro-USD (1_000_000 micros = 1 USD). Stored as integer in DB.
export function computeCostMicros(model: string, usage: TokenUsage): number {
  const price = PRICING[model];
  if (!price) {
    throw new Error(`unknown model for pricing: ${model}`);
  }

  const cacheReadTokens = usage.cacheReadTokens ?? 0;
  const inputCost = usage.inputTokens * price.in;
  const outputCost = usage.outputTokens * price.out;
  const cacheCost = cacheReadTokens * price.cacheRead;

  // (tokens * usd_per_million_tokens) yields micro-USD directly because
  // the per-million unit and 1_000_000 micros-per-USD scale cancel.
  return Math.round(inputCost + outputCost + cacheCost);
}
