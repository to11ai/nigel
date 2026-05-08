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

export const projectId: pulumi.Output<string> = project.id;
export const projectNameOutput: pulumi.Output<string> = pulumi.output(
  project.name,
);
export const appDomainOutput: pulumi.Output<string> = pulumi.output(appDomain);
