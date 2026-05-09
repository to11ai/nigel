export type ModelUsage = {
  promptTokens: number;
  completionTokens: number;
};

type PriceEntry = {
  promptUsdPerMillion: number;
  completionUsdPerMillion: number;
};

const PRICES: Record<string, PriceEntry> = {
  "anthropic/claude-haiku-4.5": {
    promptUsdPerMillion: 1,
    completionUsdPerMillion: 5,
  },
  "anthropic/claude-sonnet-4.6": {
    promptUsdPerMillion: 3,
    completionUsdPerMillion: 15,
  },
  "anthropic/claude-opus-4.6": {
    promptUsdPerMillion: 15,
    completionUsdPerMillion: 75,
  },
  "anthropic/claude-opus-4.7": {
    promptUsdPerMillion: 15,
    completionUsdPerMillion: 75,
  },
};

export function tokensToMicros(modelId: string, usage: ModelUsage): number {
  const entry = PRICES[modelId];
  if (!entry) {
    console.warn(
      `[pricing] unknown model id '${modelId}'; cost reported as 0 micros`,
    );
    return 0;
  }
  const promptMicros = usage.promptTokens * entry.promptUsdPerMillion;
  const completionMicros =
    usage.completionTokens * entry.completionUsdPerMillion;
  return Math.round(promptMicros + completionMicros);
}
