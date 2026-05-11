import { loadRepoConfig } from "@/lib/repo-config";
import type {
  PackageJsonLike,
  RepoConfig,
  TurboJsonLike,
} from "@/lib/repo-config/types";
import type { LocalStackExec } from "@/lib/local-stack";

const READ_TIMEOUT_MS = 15_000;

// Reads .nigel.yaml (and best-effort package.json + turbo.json for the
// derivation pass) from the child run's sandbox and returns a fully
// resolved RepoConfig. Falls through to the stored repo_configs row /
// inferred config when the working tree has no .nigel.yaml.
//
// Kept separate from `loadRepoConfig` itself because reading from a
// sandbox is a dispatch-layer concern (not every caller has one), and
// the file-IO surface should be unit-testable independent of the
// real sandbox.
export async function loadRepoConfigFromSandbox(input: {
  repoFullName: string;
  workingDirectory: string;
  exec: LocalStackExec;
}): Promise<RepoConfig> {
  // Fetch the three files concurrently — they're independent, and
  // serializing them stacks the per-call timeout, costing up to 3× the
  // single-read budget on a slow sandbox.
  const [yamlText, pkgJsonText, turboJsonText] = await Promise.all([
    readFileMaybe(input.exec, input.workingDirectory, ".nigel.yaml"),
    readFileMaybe(input.exec, input.workingDirectory, "package.json"),
    readFileMaybe(input.exec, input.workingDirectory, "turbo.json"),
  ]);

  const result = await loadRepoConfig({
    repoFullName: input.repoFullName,
    yamlText,
    packageJson: pkgJsonText
      ? parseJsonSafe<PackageJsonLike>(pkgJsonText)
      : null,
    turboJson: turboJsonText
      ? parseJsonSafe<TurboJsonLike>(turboJsonText)
      : null,
  });
  return result.config;
}

async function readFileMaybe(
  exec: LocalStackExec,
  cwd: string,
  relativePath: string,
): Promise<string | null> {
  // `cat` exits non-zero when the file doesn't exist; we treat that as
  // a clean miss rather than an error. Genuine sandbox failures
  // (timeouts, network issues) still surface through `exec` itself.
  const res = await exec(
    `cat ${shellQuote(relativePath)}`,
    cwd,
    READ_TIMEOUT_MS,
  );
  if (!res.success) return null;
  return res.stdout;
}

function parseJsonSafe<T>(text: string): T | null {
  try {
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
}

function shellQuote(s: string): string {
  // No shell metacharacters allowed in relative repo paths we ask for.
  // Single-quote and escape any embedded single quote.
  return `'${s.replace(/'/g, "'\\''")}'`;
}
