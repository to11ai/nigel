import * as aws from "@pulumi/aws";
import * as pulumi from "@pulumi/pulumi";

const config = new pulumi.Config();
const region = config.get("region") ?? "us-east-1";
const zoneName = config.get("zoneName") ?? "nigel.to11.ai";
const appHost = config.get("appHost") ?? `app.${zoneName}`;
const vercelCnameTarget =
  config.get("vercelCnameTarget") ?? "cname.vercel-dns.com";

const tags = {
  ManagedBy: "pulumi",
  Project: "nigel-aws-dns",
};

// Runs against the management (root) AWS account using ambient identity.
// In Pulumi Cloud deployments the identity is the OIDC role published by
// to11ai/platform's aws-workload-ci-access; locally it's the SSO admin session.
const provider = new aws.Provider("managementProvider", { region });

const zone = new aws.route53.Zone(
  "nigel-zone-prod",
  {
    name: zoneName,
    comment: `Subdomain zone for Nigel (${zoneName}). Delegated from to11.ai.`,
    forceDestroy: false,
    tags,
  },
  {
    provider,
    protect: true,
  },
);

new aws.route53.Record(
  "nigel-app-cname-prod",
  {
    zoneId: zone.zoneId,
    name: appHost,
    type: "CNAME",
    ttl: 300,
    records: [vercelCnameTarget],
  },
  {
    provider,
    parent: zone,
  },
);

export const hostedZoneId: pulumi.Output<string> = zone.zoneId;
export const hostedZoneNameServers: pulumi.Output<string[]> = zone.nameServers;
export const zoneNameOutput: pulumi.Output<string> = pulumi.output(zoneName);
export const appHostOutput: pulumi.Output<string> = pulumi.output(appHost);
