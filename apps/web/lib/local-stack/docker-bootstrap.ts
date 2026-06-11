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
// First-run image pulls can be slow; the compose-up step gets its own
// generous bound rather than borrowing the phase default (300s). After the
// first Run the sandbox snapshot caches the images, so this only bites cold.
const DEFAULT_COMPOSE_UP_TIMEOUT_SECONDS = 600;
// dockerd is launched detached so the boot command returns immediately;
// readiness is enforced by the subsequent `docker info` poll.
const DOCKERD_LOG = "/tmp/nigel-dockerd.log";

// Amazon Linux 2023's repo ships `docker` (and the buildx plugin) but NOT
// the Compose v2 plugin, so `docker compose` is unavailable after a plain
// `dnf install -y docker`. We fetch the CLI plugin binary from Docker's
// release into the standard cli-plugins dir.
//
// The version is PINNED and the digest is VERIFIED before the binary is made
// executable: it runs as root, so we don't trust a floating `latest` (it can
// change under us) nor a checksum fetched from the same release (a
// compromised release would ship a matching one). The SHA-256 below is
// embedded out-of-band at author time. Bump version + digest together from
// https://github.com/docker/compose/releases.
const COMPOSE_PLUGIN_PATH = "/usr/libexec/docker/cli-plugins/docker-compose";
const COMPOSE_PLUGIN_VERSION = "v5.1.4";
const COMPOSE_PLUGIN_SHA256 =
  "33b208d7e76639db742fae84b966cc01dacae58ca3fc4dabbc907045aefdf0c4";
const COMPOSE_PLUGIN_URL = `https://github.com/docker/compose/releases/download/${COMPOSE_PLUGIN_VERSION}/docker-compose-linux-x86_64`;

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
  // compose_file is repo-controlled, so quote it — a path with spaces would
  // otherwise split into separate shell tokens.
  return [
    "mkdir -p .nigel",
    `services=$(sudo docker compose -f "${composeFile}" config --services)`,
    `{ echo 'services:'; echo "$services" | while read -r svc; do printf '${serviceTemplate}\\n' "$svc"; done; } > ${CA_OVERRIDE_PATH}`,
  ].join(" && ");
}

// `-f base [-f override]` file chain shared by up and down. compose_file is
// quoted (repo-controlled, may contain spaces); the override path is a fixed
// space-free constant.
function composeFileArgs(docker: RepoDocker): string {
  const base = `-f "${docker.compose_file}"`;
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
    // `docker compose` isn't bundled on AL2023 — fetch the plugin, verify
    // its digest, and only then make it executable. A checksum mismatch
    // fails the step (and, after retries, the Run) rather than running an
    // unverified root binary.
    steps.push({
      cmd: [
        `sudo curl -fsSL ${COMPOSE_PLUGIN_URL} -o ${COMPOSE_PLUGIN_PATH}`,
        `echo '${COMPOSE_PLUGIN_SHA256}  ${COMPOSE_PLUGIN_PATH}' | sha256sum -c -`,
        `sudo chmod +x ${COMPOSE_PLUGIN_PATH}`,
      ].join(" && "),
      timeout_seconds: 120,
      retry: 2,
    });
    if (docker.mount_proxy_ca) {
      steps.push(buildCaOverrideCommand(docker.compose_file));
    }
    // `--wait` blocks until containers are running/healthy, baking in
    // readiness per the local_stack contract. Explicit timeout so a slow
    // cold image pull isn't cut off by the shorter phase default.
    steps.push({
      cmd: `sudo docker compose ${composeFileArgs(docker)} up -d --wait`,
      timeout_seconds: DEFAULT_COMPOSE_UP_TIMEOUT_SECONDS,
    });
  }

  return steps;
}

// Steps that bring the compose stack down. Prepended to teardown_commands.
// Uses only the base compose file — the override may not exist if startup
// failed early, and `down` does not need it.
export function buildDockerTeardownSteps(docker: RepoDocker): CommandStep[] {
  if (!docker.compose_file) return [];
  return [`sudo docker compose -f "${docker.compose_file}" down -v`];
}
