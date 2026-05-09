import { applyTurboDerivation } from "./turbo-derive";
import type { PackageJsonLike, RepoConfig, TurboJsonLike } from "./types";

export type AutoDetectInput = {
  packageJson: PackageJsonLike | null;
  turboJson: TurboJsonLike | null;
};

export function autoDetectRepoConfig({
  packageJson,
  turboJson,
}: AutoDetectInput): RepoConfig {
  const workspaces = extractWorkspaces(packageJson);
  const monorepo =
    workspaces.length > 0
      ? { workspaces, default_workspace: workspaces[0] }
      : undefined;

  const turboJsonPresent = !!turboJson;

  // Pre-fill empty checks so derivation can populate `command`. With turbo
  // off, leave checks unset — caller decides what to do.
  const checks = turboJsonPresent
    ? { lint: {}, format: {}, type_check: {}, unit_test: {}, e2e_test: {} }
    : undefined;

  const base: RepoConfig = {
    version: 1,
    setup: ["bun install --frozen-lockfile"],
    ...(monorepo ? { monorepo } : {}),
    ...(turboJsonPresent ? { turbo: { enabled: true, affected: false } } : {}),
    ...(checks ? { checks } : {}),
  };

  return applyTurboDerivation(base, { turboJsonPresent });
}

function extractWorkspaces(pkg: PackageJsonLike | null): string[] {
  if (!pkg?.workspaces) return [];
  if (Array.isArray(pkg.workspaces)) return pkg.workspaces;
  if (Array.isArray(pkg.workspaces.packages)) return pkg.workspaces.packages;
  return [];
}
