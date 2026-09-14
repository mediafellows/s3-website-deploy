import assert from "node:assert/strict";
import test from "node:test";
import {
  CreateInvalidationForDistributionTenantCommand,
  ListDistributionsByConnectionModeCommand,
  ListDistributionTenantsCommand,
} from "@aws-sdk/client-cloudfront";
import { S3WebsiteDeploy } from "../index.js";

function createDeployer(responses) {
  const deployer = Object.create(S3WebsiteDeploy.prototype);
  const commands = [];

  deployer.cfClient = {
    async send(command) {
      commands.push(command);
      return responses.shift();
    },
  };

  return { deployer, commands };
}

test("prefers temporary environment credentials over a local profile", async () => {
  const originalCredentials = {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
    sessionToken: process.env.AWS_SESSION_TOKEN,
  };

  process.env.AWS_ACCESS_KEY_ID = "OIDCTESTACCESS";
  process.env.AWS_SECRET_ACCESS_KEY = "oidctestsecret";
  process.env.AWS_SESSION_TOKEN = "oidctestsession";

  try {
    const deployer = new S3WebsiteDeploy("default", "us-east-1");
    const credentials = await deployer.s3Client.config.credentials();

    assert.equal(credentials.accessKeyId, "OIDCTESTACCESS");
    assert.equal(credentials.secretAccessKey, "oidctestsecret");
    assert.equal(credentials.sessionToken, "oidctestsession");
  } finally {
    for (const [name, value] of Object.entries(originalCredentials)) {
      const environmentName = `AWS_${name.replace(/[A-Z]/g, (letter) => `_${letter}`).toUpperCase()}`;
      if (value === undefined) {
        delete process.env[environmentName];
      } else {
        process.env[environmentName] = value;
      }
    }
  }
});

test("matches common S3 origin domain formats", () => {
  const deployer = Object.create(S3WebsiteDeploy.prototype);

  assert.equal(deployer.originUsesBucket("website-assets.s3.amazonaws.com", "website-assets"), true);
  assert.equal(deployer.originUsesBucket("website-assets.s3.eu-central-1.amazonaws.com", "website-assets"), true);
  assert.equal(deployer.originUsesBucket("website.assets.s3-website.eu-central-1.amazonaws.com", "website.assets"), true);
  assert.equal(deployer.originUsesBucket("other-bucket.s3.amazonaws.com", "website-assets"), false);
});

test("finds all paginated tenant-only distributions using the bucket", async () => {
  const { deployer, commands } = createDeployer([
    {
      DistributionList: {
        Items: [{ Id: "DIST-1", Origins: { Items: [{ DomainName: "assets.s3.eu-west-1.amazonaws.com" }] } }],
        NextMarker: "next-page",
      },
    },
    {
      DistributionList: {
        Items: [
          { Id: "DIST-2", Origins: { Items: [{ DomainName: "other.s3.amazonaws.com" }] } },
          { Id: "DIST-3", Origins: { Items: [{ DomainName: "assets.s3.amazonaws.com" }] } },
        ],
      },
    },
  ]);

  const distributionIds = await deployer.getDistributionsForBucket("assets");

  assert.deepEqual([...distributionIds], ["DIST-1", "DIST-3"]);
  assert.equal(commands.length, 2);
  assert.ok(commands.every((command) => command instanceof ListDistributionsByConnectionModeCommand));
  assert.deepEqual(commands.map((command) => command.input), [
    { ConnectionMode: "tenant-only", Marker: undefined },
    { ConnectionMode: "tenant-only", Marker: "next-page" },
  ]);
});

test("gets every paginated tenant attached to a distribution", async () => {
  const { deployer, commands } = createDeployer([
    { DistributionTenantList: [{ Id: "TENANT-1" }], NextMarker: "next-page" },
    { DistributionTenantList: [{ Id: "TENANT-2" }] },
  ]);

  const tenants = await deployer.getDistributionTenants("DIST-1");

  assert.deepEqual(tenants, [{ Id: "TENANT-1" }, { Id: "TENANT-2" }]);
  assert.ok(commands.every((command) => command instanceof ListDistributionTenantsCommand));
  assert.deepEqual(commands.map((command) => command.input), [
    { AssociationFilter: { DistributionId: "DIST-1" }, Marker: undefined },
    { AssociationFilter: { DistributionId: "DIST-1" }, Marker: "next-page" },
  ]);
});

test("creates an invalidation scoped to a distribution tenant", async () => {
  const deployer = Object.create(S3WebsiteDeploy.prototype);
  let command;
  deployer.invalidateWithExponentialBackoff = async (receivedCommand) => {
    command = receivedCommand;
    return { Invalidation: { Id: "INVALIDATION-1" } };
  };

  await deployer.createInvalidationForTenant("TENANT-1");

  assert.ok(command instanceof CreateInvalidationForDistributionTenantCommand);
  assert.equal(command.input.Id, "TENANT-1");
  assert.deepEqual(command.input.InvalidationBatch.Paths, { Quantity: 1, Items: ["/*"] });
  assert.ok(command.input.InvalidationBatch.CallerReference);
});
