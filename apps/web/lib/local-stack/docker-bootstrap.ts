import type { CommandStep, RepoConfig } from "@/lib/repo-config";

// The `docker` block from a validated local_stack. Non-null.
export type RepoDocker = NonNullable<
  NonNullable<RepoConfig["local_stack"]>["docker"]
>;

// Host path where Vercel Sandbox mounts the per-sandbox proxy CA. See
// https://vercel.com/docs/sandbox/system-specifications#proxy-ca-certificates
export const PROXY_CA_HOST_PATH =
  "/etc/pki/ca-trust/source/anchors/vercel-proxy-ca.pem";

// Where the CA is mounted inside each container, and where the env vars
// below point. /etc/ssl/certs is the conventional bundle location.
export const CA_CONTAINER_PATH = "/etc/ssl/certs/vercel-proxy-ca.pem";

// Generated compose override that mounts the CA + sets CA env vars per
// service. Lives under .nigel/ in the working directory.
export const CA_OVERRIDE_PATH = ".nigel/docker-compose.ca-override.yml";

const DEFAULT_INSTALL_TIMEOUT_SECONDS = 180;
const DEFAULT_READY_TIMEOUT_SECONDS = 60;
// dockerd is launched detached so the boot command returns immediately;
// readiness is enforced by the subsequent `docker info` poll.
const DOCKERD_LOG = "/tmp/nigel-dockerd.log";

// Amazon Linux 2023's repo ships `docker` (and the buildx plugin) but NOT
// the Compose v2 plugin, so `docker compose` is unavailable after a plain
// `dnf install -y docker`. We install the CLI plugin binary from Docker's
// release into the standard cli-plugins dir. `/latest/download/` always
// resolves to the newest release asset, avoiding a pinned version that
// rots. This is a host-level fetch (the proxy CA is present on the host),
// not a container call, so TLS to GitHub succeeds.
const COMPOSE_PLUGIN_PATH = "/usr/libexec/docker/cli-plugins/docker-compose";
const COMPOSE_PLUGIN_URL =
  "https://github.com/docker/compose/releases/latest/download/docker-compose-linux-x86_64";

// CA env vars honored by common runtimes without needing the system trust
// store rebuilt: Node, OpenSSL/curl, Python requests.
const CA_ENV_VARS = [
  "NODE_EXTRA_CA_CERTS",
  "SSL_CERT_FILE",
  "REQUESTS_CA_BUNDLE",
  "CURL_CA_BUNDLE",
] as const;

// Build the bash that enumerates the compose file's services and writes an
// override mounting the proxy CA + exporting the CA env vars into each. We
// cannot edit the repo's images, but env-var-aware clients pick up the CA
// from these without `update-ca-trust`. Emitted as a single shell step.
function buildCaOverrideCommand(composeFile: string): string {
  const envLines = CA_ENV_VARS.map(
    (name) => `      ${name}: ${CA_CONTAINER_PATH}`,
  ).join("\\n");
  const serviceTemplate = [
    "  %s:",
    "    volumes:",
    `      - ${PROXY_CA_HOST_PATH}:${CA_CONTAINER_PATH}:ro`,
    "    environment:",
    envLines,
    "",
  ].join("\\n");
  // `services=$(...)` with `&&` makes the whole step fail if `compose
  // config` fails — otherwise the redirect's exit status would mask a
  // broken compose file and silently write an empty override.
  return [
    "mkdir -p .nigel",
    `services=$(sudo docker compose -f ${composeFile} config --services)`,
    `{ echo 'services:'; echo "$services" | while read -r svc; do printf '${serviceTemplate}\\n' "$svc"; done; } > ${CA_OVERRIDE_PATH}`,
  ].join(" && ");
}

// `-f base [-f override]` file chain shared by up and down.
function composeFileArgs(docker: RepoDocker): string {
  const base = `-f ${docker.compose_file}`;
  return docker.mount_proxy_ca ? `${base} -f ${CA_OVERRIDE_PATH}` : base;
}

// Steps that install Docker, boot dockerd, wait for readiness, and (when a
// compose_file is set) bring the stack up. Run before startup_commands.
export function buildDockerStartupSteps(docker: RepoDocker): CommandStep[] {
  const steps: CommandStep[] = [
    {
      cmd: "sudo dnf install -y docker",
      timeout_seconds:
        docker.install_timeout_seconds ?? DEFAULT_INSTALL_TIMEOUT_SECONDS,
      retry: 2,
    },
    `sudo sh -c 'nohup dockerd >${DOCKERD_LOG} 2>&1 &'`,
    {
      cmd: "until sudo docker info >/dev/null 2>&1; do sleep 1; done",
      timeout_seconds:
        docker.ready_timeout_seconds ?? DEFAULT_READY_TIMEOUT_SECONDS,
    },
  ];

  if (docker.compose_file) {
    // `docker compose` isn't bundled on AL2023 — install the plugin binary.
    steps.push({
      cmd: `sudo curl -fsSL ${COMPOSE_PLUGIN_URL} -o ${COMPOSE_PLUGIN_PATH} && sudo chmod +x ${COMPOSE_PLUGIN_PATH}`,
      timeout_seconds: 120,
      retry: 2,
    });
    if (docker.mount_proxy_ca) {
      steps.push(buildCaOverrideCommand(docker.compose_file));
    }
    // `--wait` blocks until containers are running/healthy, baking in
    // readiness per the local_stack contract.
    steps.push(`sudo docker compose ${composeFileArgs(docker)} up -d --wait`);
  }

  return steps;
}

// Steps that bring the compose stack down. Prepended to teardown_commands.
// Uses only the base compose file — the override may not exist if startup
// failed early, and `down` does not need it.
export function buildDockerTeardownSteps(docker: RepoDocker): CommandStep[] {
  if (!docker.compose_file) return [];
  return [`sudo docker compose -f ${docker.compose_file} down -v`];
}
