# Upstream tracking

Nigel is a fork of [vercel-labs/open-agents](https://github.com/vercel-labs/open-agents).

## Fork base

- Upstream: `vercel-labs/open-agents`
- Forked from commit: `c1c9c1a86d42954fdf409ec60883c97635c792c7`
- Fork date: 2026-05-08

## Sync workflow

To pull changes from upstream:

```sh
git fetch upstream
git checkout main
git merge upstream/main
# resolve conflicts (most divergence is in apps/web routes and Drizzle schema)
git push origin main
```

When syncing, also update this file's "Last synced commit" entry below.

## Sync history

| Date | Upstream SHA | Notes |
|------|--------------|-------|
| 2026-05-08 | `c1c9c1a86d42954fdf409ec60883c97635c792c7` | Initial fork |
