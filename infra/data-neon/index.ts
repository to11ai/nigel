import * as neon from "@pulumi/neon";
import * as pulumi from "@pulumi/pulumi";

const config = new pulumi.Config();

const projectName = config.get("projectName") ?? "nigel prod";
const databaseName = config.get("databaseName") ?? "nigel";
const userName = config.get("userName") ?? "nigel_user";
const regionId = config.get("regionId") ?? "aws-us-east-1";
const historyRetentionSeconds = config.getNumber("historyRetentionSeconds");
const pgVersion = config.getNumber("pgVersion");

const neonProject = new neon.Project(
  "nigel-neon-project-prod",
  {
    name: projectName,
    regionId,
    ...(pgVersion !== undefined ? { pgVersion } : {}),
    ...(historyRetentionSeconds !== undefined
      ? { historyRetentionSeconds }
      : {}),
  },
  { protect: true },
);

const neonBranchId = neonProject.defaultBranchId;

const neonEndpoint = new neon.Endpoint(
  "nigel-neon-endpoint-prod",
  {
    projectId: neonProject.id,
    branchId: neonBranchId,
    type: "read_write",
    suspendTimeoutSeconds: -1,
  },
  {
    parent: neonProject,
    dependsOn: [neonProject],
    protect: true,
    replaceOnChanges: ["projectId", "branchId", "type"],
  },
);

const neonRole = new neon.Role(
  "nigel-neon-role-prod",
  {
    projectId: neonProject.id,
    branchId: neonBranchId,
    name: userName,
  },
  {
    parent: neonProject,
    dependsOn: [neonProject, neonEndpoint],
    protect: true,
    replaceOnChanges: ["projectId", "branchId", "name"],
  },
);

const neonDatabase = new neon.Database(
  "nigel-neon-database-prod",
  {
    projectId: neonProject.id,
    branchId: neonBranchId,
    name: databaseName,
    ownerName: neonRole.name,
  },
  {
    parent: neonProject,
    dependsOn: [neonEndpoint, neonRole],
    protect: true,
    replaceOnChanges: ["projectId", "branchId", "ownerName"],
  },
);

export const projectId = neonProject.id;
export const branchId = neonBranchId;
export const host = neonEndpoint.host;
export const database = neonDatabase.name;
export const user = neonRole.name;
export const postgresUrl = pulumi.secret(
  pulumi
    .all([neonRole.name, neonRole.password, neonEndpoint.host, neonDatabase.name])
    .apply(([dbUser, dbPassword, dbHost, dbName]) => {
      if (!dbPassword) {
        throw new Error(
          "Neon role password is empty; unable to build postgresUrl.",
        );
      }
      return `postgresql://${encodeURIComponent(dbUser)}:${encodeURIComponent(dbPassword)}@${dbHost}/${encodeURIComponent(dbName)}?sslmode=require`;
    }),
);
export const postgresPoolerUrl = pulumi.secret(
  pulumi
    .all([
      neonRole.name,
      neonRole.password,
      neonProject.databaseHostPooler,
      neonDatabase.name,
    ])
    .apply(([dbUser, dbPassword, poolerHost, dbName]) => {
      if (!dbPassword) {
        throw new Error(
          "Neon role password is empty; unable to build postgresPoolerUrl.",
        );
      }
      return `postgresql://${encodeURIComponent(dbUser)}:${encodeURIComponent(dbPassword)}@${poolerHost}/${encodeURIComponent(dbName)}?sslmode=require`;
    }),
);
