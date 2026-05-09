import { load } from "js-yaml";
import { RepoConfigSchema, type RepoConfig } from "./types";

export class RepoConfigParseError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "RepoConfigParseError";
  }
}

export function parseNigelYaml(text: string): RepoConfig {
  let raw: unknown;
  try {
    raw = load(text);
  } catch (err) {
    throw new RepoConfigParseError(
      `failed to parse .nigel.yaml: ${(err as Error).message}`,
      { cause: err },
    );
  }
  if (
    raw === null ||
    raw === undefined ||
    typeof raw !== "object" ||
    Array.isArray(raw)
  ) {
    throw new RepoConfigParseError(
      `.nigel.yaml must be a YAML mapping at the top level`,
    );
  }
  const parsed = RepoConfigSchema.safeParse(raw);
  if (!parsed.success) {
    throw new RepoConfigParseError(
      `.nigel.yaml failed schema validation: ${parsed.error.message}`,
      { cause: parsed.error },
    );
  }
  return parsed.data;
}
