# Nigel

Nigel is a fork of [vercel-labs/open-agents](https://github.com/vercel-labs/open-agents) extended with hierarchical multi-agent orchestration, Linear ticket triggers, an expanded tool surface (browser, database, cloud, MCP, Slack), per-repo `.nigel.yaml` config, and Datadog-backed observability.

See [docs/product-specs/2026-05-08-nigel-system-design.md](docs/product-specs/2026-05-08-nigel-system-design.md) for the design.

See [UPSTREAM.md](UPSTREAM.md) for upstream tracking and sync workflow.

## Status

Phase 0 complete: forked, rebranded, GitHub-only auth. Subsequent phases live in [docs/exec-plans/active/](docs/exec-plans/active/).

## Local setup

```sh
bun install
cp apps/web/.env.example apps/web/.env
# fill in POSTGRES_URL, BETTER_AUTH_SECRET, and GitHub App credentials
bun run web
```

## Auth

Nigel uses [Better Auth](https://www.better-auth.com/) with GitHub as the only social provider. The GitHub App's OAuth credentials are also used for repo access, pushes, and PRs.

## Deploy

Vercel project + Neon Postgres are provisioned via Pulumi (see [infra/](infra/)). The Vercel project is linked to this repo and auto-deploys on push.
