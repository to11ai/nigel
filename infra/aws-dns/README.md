# nigel-aws-dns

Pulumi project that owns the `nigel.to11.ai` Route53 hosted zone and DNS records inside it.

## Account

Runs against the **management (root) AWS account** with ambient identity (SSO admin locally; OIDC role in CI). Mirrors the `to11ai/platform/infra/aws-root-dns/root` pattern — no `assumeRole`.

## Stacks

- `to11/nigel-aws-dns/root` — production zone.

## Resources

- `aws.route53.Zone` for `nigel.to11.ai` (delegated from `to11.ai`).
- `aws.route53.Record` CNAME `app.nigel.to11.ai` → `cname.vercel-dns.com`.

## Outputs

- `hostedZoneId`
- `hostedZoneNameServers` — consumed by `to11ai/platform/infra/aws-root-dns/root` to delegate from `to11.ai`.
- `hostedZoneName`, `appHostOutput`

## Delegation (one-time, in platform repo)

After this stack's first apply, the platform repo's `aws-root-dns/root` stack must add an `aws.route53.Record` of type `NS` for `nigel.to11.ai` in the `to11.ai` zone, with values pulled from this stack's `hostedZoneNameServers` output via `pulumi.StackReference`. Until that record exists, `nigel.to11.ai` (and therefore `app.nigel.to11.ai`) will not resolve from public DNS.

## Initial provisioning

See `docs/exec-plans/active/2026-05-08-nigel-phase-0-fork-and-rebrand-plan.md` Task 15.
