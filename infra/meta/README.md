# nigel-meta

Pulumi project that configures Pulumi Cloud Deployments and the auto-deploy DAG for every Nigel infra stack.

## Stacks

- `to11/nigel-meta/prod` — production meta stack.

Mirrors the platform repo's `infra/meta` pattern but scoped to Nigel-only stacks.

## What it owns

For each Nigel infra stack, this project creates:

- A `pulumiservice.DeploymentSettings` resource — wires Pulumi Cloud Deployments to `to11ai/nigel`'s `main` branch with path filters that scope which file changes retrigger which stack.
- An `autodeploy.AutoDeployer` resource — fans out cross-stack triggers when an upstream stack updates.

## Stack DAG

```
nigel-aws-dns/root      (leaf)
nigel-data-neon/prod  → nigel-vercel/prod
nigel-vercel/prod       (leaf)
```

`nigel-vercel` reads `postgresUrl` from `nigel-data-neon` via StackReference, so a Neon update retriggers the Vercel stack. `nigel-aws-dns` has no Nigel-side downstream — its name servers are consumed cross-repo by `to11ai/platform`'s `aws-root-dns/root` stack, but cross-repo auto-deploy is not wired in this version (a Nigel zone change requires a manual reapply on `aws-root-dns/root`).

## Dependencies

- `to11/aws-workload-ci-access/root` (in `to11ai/platform`) — provides `pulumiDeploymentsRoleArn`, the AWS OIDC role used by Pulumi Cloud Deployments. Nigel piggybacks on it instead of provisioning a parallel role.

## Initial setup

```sh
cd infra/meta
pulumi stack init to11/nigel-meta/prod
pulumi up --yes
```

Pulumi Cloud Deployments will start auto-deploying every Nigel infra stack on merge to `main` once this stack is applied.
