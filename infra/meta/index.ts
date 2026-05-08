import * as autodeploy from "@pulumi/auto-deploy";
import * as pulumi from "@pulumi/pulumi";
import * as pulumiservice from "@pulumi/pulumiservice";

const config = new pulumi.Config();
const org = pulumi.getOrganization();
const repo = config.get("repo") ?? "to11ai/nigel";
const branch = config.get("branch") ?? "refs/heads/main";

// AWS OIDC role from the platform repo's CI-access stack — same role the
// platform stacks use for Pulumi Cloud Deployments. Nigel piggybacks on it
// instead of provisioning a parallel role in the management account.
const ciAccessRef = new pulumi.StackReference(
  `${org}/aws-workload-ci-access/root`,
);
const awsOidcRoleArn = ciAccessRef.requireOutput("pulumiDeploymentsRoleArn");

const awsOidc = {
  aws: {
    roleARN: awsOidcRoleArn as unknown as string,
    sessionName: "pulumi-deployments",
  },
};

// Root workspace files that every Nigel stack's preRun depends on.
const rootWorkspacePaths = ["package.json", "turbo.json", "bun.lock"];

interface StackDeploymentConfig {
  project: string;
  stack: string;
  sourceDir: string;
  paths: string[];
  oidc?: { aws: { roleARN: string; sessionName: string } };
}

function createDeploymentSettings(
  name: string,
  opts: StackDeploymentConfig,
): pulumiservice.DeploymentSettings {
  return new pulumiservice.DeploymentSettings(name, {
    organization: org,
    project: opts.project,
    stack: opts.stack,
    sourceContext: {
      git: {
        branch,
        repoDir: opts.sourceDir,
      },
    },
    operationContext: {
      options: { skipIntermediateDeployments: true },
      preRunCommands: [
        "curl -fsSL https://bun.sh/install | bash",
        `export PATH="$HOME/.bun/bin:$PATH" && cd ../.. && bun install --frozen-lockfile && cd ${opts.sourceDir}`,
      ],
      ...(opts.oidc ? { oidc: opts.oidc } : {}),
    },
    github: {
      repository: repo,
      // Phase 0 is single-env (prod). Auto-deploy on merge to main; preview on PRs.
      // If/when a stg env is added, flip to deployCommits=false on prod for manual approval.
      deployCommits: true,
      previewPullRequests: true,
      paths: [...opts.paths, ...rootWorkspacePaths],
    },
    cacheOptions: { enable: true },
  });
}

// --- Deployment settings (one per Nigel stack) ---

const awsDnsRoot = createDeploymentSettings("nigel-aws-dns-root", {
  project: "nigel-aws-dns",
  stack: "root",
  sourceDir: "infra/aws-dns",
  paths: ["infra/aws-dns/**"],
  oidc: awsOidc,
});

const dataNeonProd = createDeploymentSettings("nigel-data-neon-prod", {
  project: "nigel-data-neon",
  stack: "prod",
  sourceDir: "infra/data-neon",
  paths: ["infra/data-neon/**"],
});

const vercelProd = createDeploymentSettings("nigel-vercel-prod", {
  project: "nigel-vercel",
  stack: "prod",
  sourceDir: "infra/vercel",
  paths: ["infra/vercel/**"],
});

// --- Auto-deploy chain ---
// Vercel stack reads postgresUrl from data-neon via StackReference, so a
// data-neon update must retrigger vercel. aws-dns has no downstream within
// Nigel; cross-repo retrigger of platform's aws-root-dns/root after a
// nameserver rotation is handled manually for now.

const autoVercel = new autodeploy.AutoDeployer(
  "nigel-vercel-prod-auto",
  {
    organization: org,
    project: "nigel-vercel",
    stack: "prod",
    downstreamRefs: [],
  },
  { dependsOn: [vercelProd] },
);

new autodeploy.AutoDeployer(
  "nigel-data-neon-prod-auto",
  {
    organization: org,
    project: "nigel-data-neon",
    stack: "prod",
    downstreamRefs: [autoVercel.ref],
  },
  { dependsOn: [dataNeonProd] },
);

new autodeploy.AutoDeployer(
  "nigel-aws-dns-root-auto",
  {
    organization: org,
    project: "nigel-aws-dns",
    stack: "root",
    downstreamRefs: [],
  },
  { dependsOn: [awsDnsRoot] },
);

export const deploymentSettingIds = {
  awsDnsRoot: awsDnsRoot.id,
  dataNeonProd: dataNeonProd.id,
  vercelProd: vercelProd.id,
};
