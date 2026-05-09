import { autoDetectRepoConfig } from "./auto-detect";
import { parseNigelYaml } from "./parse";
import { getRepoConfigRow, upsertRepoConfigRow } from "./repository";
import { applyTurboDerivation } from "./turbo-derive";
import {
  type LoadRepoConfigResult,
  type PackageJsonLike,
  RepoConfigSchema,
  type TurboJsonLike,
} from "./types";

export type LoadRepoConfigInput = {
  repoFullName: string;
  yamlText: string | null;
  packageJson: PackageJsonLike | null;
  turboJson: TurboJsonLike | null;
};

const INFERRED_WARNING =
  "no .nigel.yaml found — inferred config used. Commit .nigel.yaml for canonical setup.";

export class RepoConfigCorruptError extends Error {
  constructor(repoFullName: string, options?: { cause?: unknown }) {
    super(
      `stored repo_configs row for '${repoFullName}' failed schema validation; the row is stale or corrupt and must be repaired before it can be used`,
      options,
    );
    this.name = "RepoConfigCorruptError";
  }
}

export async function loadRepoConfig(
  input: LoadRepoConfigInput,
): Promise<LoadRepoConfigResult> {
  if (input.yamlText !== null) {
    const parsed = parseNigelYaml(input.yamlText);
    const derived = applyTurboDerivation(parsed, {
      turboJsonPresent: !!input.turboJson,
    });
    return { source: "file", config: derived } as const;
  }

  const row = await getRepoConfigRow(input.repoFullName);
  if (row) {
    // Re-validate stored config every time. A row could pre-date a schema
    // change, or someone could have hand-edited it in the DB; either way the
    // resolver should surface the problem rather than hand the caller a
    // structurally invalid `RepoConfig`.
    const validated = RepoConfigSchema.safeParse(row.configJson);
    if (!validated.success) {
      throw new RepoConfigCorruptError(input.repoFullName, {
        cause: validated.error,
      });
    }
    // Re-apply Turbo derivation on read. Stored rows may have been written
    // before derivation was added, or admin-edited without it. Derivation is
    // idempotent — explicit commands always win — so applying it twice is
    // safe.
    const derived = applyTurboDerivation(validated.data, {
      turboJsonPresent: !!input.turboJson,
    });
    if (row.source === "inferred") {
      return {
        source: "inferred",
        config: derived,
        warning: INFERRED_WARNING,
      };
    }
    return { source: row.source, config: derived } as const;
  }

  const inferred = autoDetectRepoConfig({
    packageJson: input.packageJson,
    turboJson: input.turboJson,
  });
  await upsertRepoConfigRow(input.repoFullName, inferred, "inferred");
  return {
    source: "inferred",
    config: inferred,
    warning: INFERRED_WARNING,
  } as const;
}
