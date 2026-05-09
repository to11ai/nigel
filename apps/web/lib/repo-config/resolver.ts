import { autoDetectRepoConfig } from "./auto-detect";
import { parseNigelYaml } from "./parse";
import { getRepoConfigRow, upsertRepoConfigRow } from "./repository";
import { applyTurboDerivation } from "./turbo-derive";
import type {
  LoadRepoConfigResult,
  PackageJsonLike,
  RepoConfig,
  TurboJsonLike,
} from "./types";

export type LoadRepoConfigInput = {
  repoFullName: string;
  yamlText: string | null;
  packageJson: PackageJsonLike | null;
  turboJson: TurboJsonLike | null;
};

const INFERRED_WARNING =
  "no .nigel.yaml found — inferred config used. Commit .nigel.yaml for canonical setup.";

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
    if (row.source === "inferred") {
      return {
        source: "inferred",
        config: row.configJson as RepoConfig,
        warning: INFERRED_WARNING,
      };
    }
    return {
      source: row.source,
      config: row.configJson as RepoConfig,
    } as const;
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
