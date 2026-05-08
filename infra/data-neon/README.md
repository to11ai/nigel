# nigel-data-neon

Pulumi project that provisions Nigel's Neon Postgres database.

## Stacks

- `to11/nigel-data-neon/prod` — production database.

Nigel is prod-only. There are no `dev` or `stg` stacks.

## Outputs

- `projectId` — Neon project ID
- `branchId` — Neon branch ID (the project's default branch)
- `host` — Neon endpoint host
- `database` — database name
- `user` — role name
- `postgresUrl` — full Postgres connection URL (secret)
- `postgresPoolerUrl` — pgbouncer pooler URL (secret)

## Initial provisioning

See `docs/exec-plans/active/2026-05-08-nigel-phase-0-fork-and-rebrand-plan.md` Task 17.
