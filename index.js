import { S3Client, ListObjectsV2Command, DeleteObjectsCommand } from "@aws-sdk/client-s3";
import { Upload } from "@aws-sdk/lib-storage";
import { CloudFrontClient, ListDistributionsByConnectionModeCommand, ListDistributionTenantsCommand, CreateInvalidationForDistributionTenantCommand } from "@aws-sdk/client-cloudfront";
import { IncomingWebhook } from '@slack/webhook';
import { readdir, stat } from "fs/promises";
import { join } from "path";
import mime from "mime";
import * as fs from "fs";

class S3WebsiteDeploy {
  /**
   * Initialize S3WebsiteDeploy object with some basic settings
   * @param {string} awsProfile  The AWS profile to use for AWS clients
   * @param {string} awsRegion   The AWS region to use for AWS clients
   * @param {string} slackUrl    The Slack webhook secret URL, if given will report deployment messages there
   */
  constructor(awsProfile = 'default', awsRegion = 'us-east-1', slackUrl){
    console.log(`Using AWS profile ${awsProfile} and region ${awsRegion}`);

    this.cfClient = new CloudFrontClient({ profile: awsProfile, region: awsRegion }); // CloudFront is global, but you can still set a default region// AWS S3 Configuration
    this.s3Client = new S3Client({ region: awsRegion, profile: awsProfile });
    this.slackUrl = slackUrl;
  }

  // Get multi-tenant CloudFront distribution IDs that use the given S3 bucket.
  async getDistributionsForBucket(bucketName) {
    const distributionIds = new Set();
    let marker;

    console.log(`Looking for multi-tenant CloudFront distributions using bucket ${bucketName}...`);

    do {
      const command = new ListDistributionsByConnectionModeCommand({
        ConnectionMode: "tenant-only",
        Marker: marker,
      });
      const response = await this.cfClient.send(command);
      const distributionList = response.DistributionList;

      for (const distribution of distributionList?.Items || []) {
        const usesBucket = distribution.Origins?.Items?.some((origin) => this.originUsesBucket(origin.DomainName, bucketName));
        if (usesBucket) {
          distributionIds.add(distribution.Id);
          console.log(`Found multi-tenant CloudFront distribution with ID: ${distribution.Id}`);
        }
      }

      marker = distributionList?.NextMarker;
    } while (marker);

    if (distributionIds.size === 0) {
      throw new Error(`No multi-tenant CloudFront distribution found for S3 bucket ${bucketName}`);
    }

    return distributionIds;
  }

  originUsesBucket(originDomain, bucketName) {
    const escapedBucketName = bucketName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp(`^${escapedBucketName}\\.s3(?:[.-][a-z0-9-]+)*\\.amazonaws\\.com(?:\\.cn)?$`, "i").test(originDomain);
  }

  // Get all tenants attached to a multi-tenant CloudFront distribution.
  async getDistributionTenants(distributionId) {
    const tenants = [];
    let marker;

    do {
      const command = new ListDistributionTenantsCommand({
        AssociationFilter: { DistributionId: distributionId },
        Marker: marker,
      });
      const response = await this.cfClient.send(command);
      tenants.push(...(response.DistributionTenantList || []));
      marker = response.NextMarker;
    } while (marker);

    return tenants;
  }

  // Create a CloudFront invalidation for a distribution tenant.
  async createInvalidationForTenant(tenantId) {
    const paths = ['/*'] // simply invalidate all files
    const timestamp = Date.now().toString(); // Unique ID for the invalidation
    const command = new CreateInvalidationForDistributionTenantCommand({
      Id: tenantId,
      InvalidationBatch: {
        CallerReference: timestamp,
        Paths: {
          Quantity: paths.length,
          Items: paths,
        },
      },
    });

    try {
      const response = await this.invalidateWithExponentialBackoff(command);
      console.log(`CloudFront invalidation created for tenant ${tenantId}:`, response.Invalidation.Id);
    } catch (error) {
      throw new Error(`Error creating invalidation for tenant ${tenantId}`, { cause: error });
    }
  }

  // Cleanup S3 bucket by finding all files and removing them
  async cleanupS3Bucket(bucketName) {
    let continuationToken;
    let hasMore = true;

    console.log(`Listing and deleting contents of bucket: ${bucketName}`);

    while (hasMore) {
      try {
        // List objects in the bucket
        const listCommand = new ListObjectsV2Command({
          Bucket: bucketName,
          ContinuationToken: continuationToken,
        });

        const listResponse = await this.s3Client.send(listCommand);

        if (listResponse.Contents && listResponse.Contents.length > 0) {
          // Prepare objects for deletion
          const objectsToDelete = listResponse.Contents.map((item) => ({ Key: item.Key }));

          // Delete objects
          const deleteCommand = new DeleteObjectsCommand({
            Bucket: bucketName,
            Delete: {
              Objects: objectsToDelete,
            },
          });

          const deleteResponse = await this.s3Client.send(deleteCommand);
          console.log(`Deleted objects:`, deleteResponse.Deleted.map((obj) => obj.Key));
        }

        // Check if there are more objects to process
        if (listResponse.IsTruncated) {
          continuationToken = listResponse.NextContinuationToken;
        } else {
          hasMore = false;
        }
      } catch (error) {
        console.error("Error processing bucket contents:", error);
        process.exit(1);
        break;
      }
    }

    console.log("Finished cleaning bucket.");
  }

  // Recursively upload files from a local directory to S3.
  async uploadDirectoryToS3(dir, bucketName, s3Prefix = "") {
    const files = await readdir(dir);

    for (const file of files) {
      const filePath = join(dir, file);
      const fileStat = await stat(filePath);

      if (fileStat.isDirectory()) {
        // Recursively upload subdirectory
        await this.uploadDirectoryToS3(filePath, bucketName, join(s3Prefix, file));
      } else {
        // Upload file
        const fileStream = fs.createReadStream(filePath);
        const mimeType = mime.getType(filePath) || "application/octet-stream";
        const s3Key = join(s3Prefix, file);

        console.log(`Uploading ${filePath} to s3://${bucketName}/${s3Key}`);

        const uploadParams = {
          Bucket: bucketName,
          Key: s3Key.replace(/\\/g, "/"), // Ensure S3 key uses forward slashes
          Body: fileStream,
          ContentType: mimeType, // Set the MIME type
        };

        const resp = new Upload({ client: this.s3Client, params: uploadParams });

        try {
          await resp.done();
          // console.log(`Uploaded: ${s3Key}`);
        } catch (error) {
          console.error(`Failed to upload ${s3Key}:`, error);
          process.exit(1);
        }
      }
    }
  }

  /** Wrapper method to do all deployment steps
  * @param {string} bucketName        S3 bucket to deploy to
  * @param {string} localDirectory    Directory that contains the artefacts to deploy, point your build output there
  */
  async deploy(bucketName, localDirectory) {
    console.log('')
    console.log(`=== Starting deploy to S3 bucket: ${bucketName} ===`);

    // 1. Find multi-tenant CloudFront distributions that use the bucket.
    const distributionIds = await this.getDistributionsForBucket(bucketName)

    // 2. Find every tenant attached to those distributions before changing S3.
    const tenants = [];
    for (const distributionId of distributionIds) {
      tenants.push(...await this.getDistributionTenants(distributionId));
    }

    if (tenants.length === 0) {
      throw new Error(`No CloudFront distribution tenants found for S3 bucket ${bucketName}`);
    }

    console.log("");
    console.log(`Found ${tenants.length} CloudFront distribution tenant(s)`);
    console.log(`Will upload to bucket ${bucketName} from local dir: ${localDirectory}`);
    console.log("");

    // 3. Cleanup S3 bucket (i.e. delete all present files).
    await this.cleanupS3Bucket(bucketName)
    console.log("");

    // 4. Upload new files to S3.
    await this.uploadDirectoryToS3(localDirectory, bucketName)
    console.log(`Upload completed to ${bucketName} bucket`)

    console.log("");

    // 5. Invalidate every tenant's cache to ensure new content is served.
    for (const tenant of tenants) {
      await this.createInvalidationForTenant(tenant.Id)
    }

    console.log("");
    console.log("All done");

    // 6. Send Slack message
    const slack = new IncomingWebhook(this.slackUrl);
    try {
      await slack.send({ text: `successfully deployed UI to S3 bucket ${bucketName} and invalidated ${tenants.length} CloudFront tenant(s)` });
    } catch (error) {
      console.error("Failed to send Slack message:", error.message)
    }
  }

  async invalidateWithExponentialBackoff(command) {
    const maxRetries = 5;
    let delay = 500;

    for (let i = 0; i < maxRetries; i++) {
      try {
        return await this.cfClient.send(command);
      } catch (error) {
        console.log(`Attempt ${i + 1} failed. Retrying in ${delay}ms...`, error);
        await new Promise(resolve => setTimeout(resolve, delay));
        delay *= 2;
      }
    }
    throw new Error('Max retries reached');
  }
}

export { S3WebsiteDeploy };
