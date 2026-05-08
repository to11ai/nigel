# nigel-vercel

Pulumi project that provisions Nigel's Vercel project, custom domain, and Pulumi-managed env vars.

## Stacks

- `to11/nigel-vercel/prod` — production app.

## Depends on

- `to11/nigel-data-neon/prod` (for `postgresUrl`)

## Outputs

- `projectId` — Vercel project ID
- `projectNameOutput` — Vercel project name
- `appDomainOutput` — custom domain (e.g., `app.nigel.to11.ai`)

## Initial provisioning

See `docs/exec-plans/active/2026-05-08-nigel-phase-0-fork-and-rebrand-plan.md` Tasks 17 and 18.
