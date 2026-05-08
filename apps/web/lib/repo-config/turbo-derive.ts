import type { RepoConfig } from "./types";

const DEFAULT_TASKS = {
  lint: "lint",
  format: "format:check",
  type_check: "check-types",
  unit_test: "test:unit",
  e2e_test: "test:e2e",
  dev: "dev",
} as const;

type CheckKey = "lint" | "format" | "type_check" | "unit_test" | "e2e_test";

export function applyTurboDerivation(
  config: RepoConfig,
  { turboJsonPresent }: { turboJsonPresent: boolean },
): RepoConfig {
  const turboEnabled = config.turbo?.enabled ?? turboJsonPresent;
  if (!turboEnabled) return config;

  const taskMap = config.turbo?.task_map ?? {};
  const defaultWorkspace = config.monorepo?.default_workspace;

  const deriveCommand = (key: CheckKey): string => {
    const task = taskMap[key] ?? DEFAULT_TASKS[key];
    if (key === "e2e_test" && defaultWorkspace) {
      return `turbo run ${task} --filter=${defaultWorkspace}`;
    }
    return `turbo run ${task}`;
  };

  const checks = { ...config.checks };
  for (const key of [
    "lint",
    "format",
    "type_check",
    "unit_test",
    "e2e_test",
  ] as CheckKey[]) {
    const existing = checks[key];
    if (existing && existing.command === undefined) {
      checks[key] = { ...existing, command: deriveCommand(key) };
    }
  }

  let devServer = config.dev_server;
  if (devServer && devServer.command === undefined) {
    const devTask = taskMap.dev ?? DEFAULT_TASKS.dev;
    const filter = defaultWorkspace ? ` --filter=${defaultWorkspace}` : "";
    devServer = { ...devServer, command: `turbo run ${devTask}${filter}` };
  }

  return {
    ...config,
    checks,
    ...(devServer ? { dev_server: devServer } : {}),
  };
}
