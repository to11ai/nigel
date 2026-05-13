import * as pulumi from "@pulumi/pulumi";
import * as vercel from "@pulumiverse/vercel";

const config = new pulumi.Config();

const projectName = config.get("projectName") ?? "nigel-prod";
const appDomain = config.get("appDomain") ?? "app.nigel.to11.ai";

const neonStackRef = new pulumi.StackReference(config.require("neonStackRef"));
const postgresUrl = neonStackRef.requireOutput(
  "postgresUrl",
) as pulumi.Output<string>;

const project = new vercel.Project(
  "nigel-vercel-project-prod",
  {
    name: projectName,
    framework: "nextjs",
    buildCommand:
      config.get("buildCommand") ?? "cd ../.. && bun run --cwd apps/web build",
    serverlessFunctionRegion: config.get("functionRegion") ?? "iad1",
    rootDirectory: "apps/web",
    gitRepository: {
      type: "github",
      repo: "to11ai/nigel",
    },
  },
  {
    protect: true,
    import: config.get("vercelProjectId"),
  },
);

new vercel.ProjectDomain(
  "nigel-vercel-domain-prod",
  {
    projectId: project.id,
    domain: appDomain,
  },
  {
    parent: project,
    protect: true,
  },
);

function envVar(
  name: string,
  value: pulumi.Input<string>,
  opts: {
    targets?: string[];
    sensitive?: boolean;
  } = {},
): vercel.ProjectEnvironmentVariable {
  const targets = opts.targets ?? ["production", "preview"];
  return new vercel.ProjectEnvironmentVariable(
    `nigel-vercel-env-${name.toLowerCase().replace(/_/g, "-")}-prod`,
    {
      projectId: project.id,
      key: name,
      value,
      targets,
      sensitive: opts.sensitive ?? false,
    },
    {
      parent: project,
      protect: true,
      deleteBeforeReplace: true,
    },
  );
}

envVar("POSTGRES_URL", postgresUrl, { sensitive: true });
envVar("BETTER_AUTH_SECRET", config.requireSecret("betterAuthSecret"), {
  sensitive: true,
});
// Encryption key for tool_connections.secrets_ciphertext (Phase 5a).
// 32 bytes of base64-encoded random. Same value targets production and
// preview so secrets written in one env can be decrypted in the other
// (Neon DB branching forks rows across the two). Rotating this key
// invalidates every stored ciphertext until a re-encrypt migration
// exists, so set it once and leave it.
envVar(
  "TOOL_CONNECTIONS_ENC_KEY",
  config.requireSecret("toolConnectionsEncKey"),
  { sensitive: true },
);

// Better Auth's allowed-hosts list pulls from BETTER_AUTH_URL +
// VERCEL_PROJECT_PRODUCTION_URL. Without these the custom domain isn't on the
// trust list and the OAuth callback silently drops the session.
//
// BETTER_AUTH_URL is production-only: getAuthBaseURLFallback() in auth/config.ts
// returns BETTER_AUTH_URL ?? VERCEL_URL. On preview deployments we want the
// per-deploy VERCEL_URL (which Vercel injects automatically) to be the
// fallback, not the production domain — otherwise OAuth callbacks on preview
// builds redirect to production and the preview session never sets.
envVar("BETTER_AUTH_URL", `https://${appDomain}`, {
  targets: ["production"],
});
envVar("VERCEL_PROJECT_PRODUCTION_URL", appDomain);
envVar("NEXT_PUBLIC_VERCEL_PROJECT_PRODUCTION_URL", appDomain);

envVar("NEXT_PUBLIC_GITHUB_CLIENT_ID", config.require("githubClientId"));
envVar("GITHUB_CLIENT_SECRET", config.requireSecret("githubClientSecret"), {
  sensitive: true,
});
envVar("GITHUB_APP_ID", config.require("githubAppId"));
envVar("GITHUB_APP_PRIVATE_KEY", config.requireSecret("githubAppPrivateKey"), {
  sensitive: true,
});
envVar("NEXT_PUBLIC_GITHUB_APP_SLUG", config.require("githubAppSlug"));
envVar("GITHUB_WEBHOOK_SECRET", config.requireSecret("githubWebhookSecret"), {
  sensitive: true,
});

// Restrict sign-in to active members of this GitHub org. Unset on a stack
// disables the check (useful for staging/dev branches without a paired org).
const allowedGithubOrg = config.get("allowedGithubOrg");
if (allowedGithubOrg) {
  envVar("NIGEL_ALLOWED_GITHUB_ORG", allowedGithubOrg);
}

// OpenTelemetry export (Phase 7a). All three are optional per-stack —
// when the endpoint is unset, `@vercel/otel` still installs the
// auto-instrumentation but drops exports, so the app keeps working in
// stacks that don't ship telemetry. The headers value typically
// carries the Dash0 auth bearer; mark it sensitive so it doesn't
// leak into Pulumi outputs.
const otelEndpoint = config.get("otelExporterOtlpEndpoint");
if (otelEndpoint) {
  envVar("OTEL_EXPORTER_OTLP_ENDPOINT", otelEndpoint);
}
const otelHeaders = config.getSecret("otelExporterOtlpHeaders");
if (otelHeaders) {
  envVar("OTEL_EXPORTER_OTLP_HEADERS", otelHeaders, { sensitive: true });
}
const otelServiceName = config.get("otelServiceName");
if (otelServiceName) {
  envVar("OTEL_SERVICE_NAME", otelServiceName);
}

export const projectId: pulumi.Output<string> = project.id;
export const projectNameOutput: pulumi.Output<string> = pulumi.output(
  project.name,
);
export const appDomainOutput: pulumi.Output<string> = pulumi.output(appDomain);
