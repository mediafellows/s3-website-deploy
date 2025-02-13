import { S3Client, ListObjectsV2Command, DeleteObjectsCommand } from "@aws-sdk/client-s3";
import { Upload } from "@aws-sdk/lib-storage";
import { CloudFrontClient, ListDistributionsCommand, GetDistributionCommand, CreateInvalidationCommand } from "@aws-sdk/client-cloudfront";
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

  // Get Cloudfront Ids for a given domain alias
  async getDistributionsForDomains(cfDomains) {
    const uniqueCfIds = new Set();
    let distributions;
    let dist;
    let marker;
    let cfId;

    for (const domain of cfDomains) {
      console.log(`Looking for domain ${domain} in CloudFront distributions...`);
      // Making sure all variables are nulled, so no values are reused from previous iteration!
      distributions = null;
      dist = null;
      marker = null;
      cfId = null;

      do {
        // Fetch distributions with the current marker, as results may be paginated
        const command = new ListDistributionsCommand({ Marker: marker });
        distributions = await this.cfClient.send(command);
        dist = distributions.DistributionList.Items.find((item) => item.Aliases?.Items?.includes(domain));
        // console.log(`dist: ${dist} | marker: ${marker}`);
        marker = distributions.DistributionList.NextMarker;
      } while (!dist && marker);

      if (!dist) {
        console.error(`No CloudFront distribution found for domain ${domain}`);
        continue;
      }

      cfId = dist.Id;
      console.log(`Found CloudFront distribution with ID: ${cfId}`);
      uniqueCfIds.add(cfId);
    }

    if (uniqueCfIds.length === 0) {
      console.log(`Found no Cloudfront distribution for any of the given domains ${cfDomains}`);
      process.exit(1);
    }
    return uniqueCfIds;
  }

  // Get distribution details for specific Cloudfront ID
  async getDistribution(distributionId) {
    try {
      const command = new GetDistributionCommand({ Id: distributionId });
      const response = await this.cfClient.send(command);
      // console.log("Distribution Details:", response.Distribution);
      return response.Distribution;
    } catch (error) {
      console.error("Error getting distribution details:", error);
      process.exit(1);
    }
  }

  // Create Cloudfront invalidation for given CF id
  async createInvalidation(distributionId) {
    const paths = ['/*'] // simply invalidate all files
    const timestamp = Date.now().toString(); // Unique ID for the invalidation
    const command = new CreateInvalidationCommand({
      DistributionId: distributionId,
      InvalidationBatch: {
        CallerReference: timestamp,
        Paths: {
          Quantity: paths.length,
          Items: paths,
        },
      },
    });

    try {
      const response = await this.cfClient.send(command);
      console.log("Cloudfront invalidation created:", response.Invalidation.Id);
    } catch (error) {
      console.error("Error creating invalidation:", error);
      process.exit(1);
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
  * @param {array} domains            List of domains to deploy to (at leat one per Cloudfront distribution to match deploy targets)
  * @param {string} localDirectory    Directory that contains the artefacts to deploy, point your build output there
  */
  async deploy(domains, localDirectory) {
    console.log('')
    console.log(`=== Starting deploy for domains: ${new Array(...domains).join(', ')} ===`);

    // 1. Find Cloudfront distributions for given list of domains
    const cfIds = await this.getDistributionsForDomains(domains)

    // 2. Extract bucket names from Cloudfront distributions
    const bucketNames = new Set();
    for (const id of cfIds) {
      const distribution = await this.getDistribution(id)
      const s3Domain = distribution.DistributionConfig.Origins.Items[0].DomainName;
      const bucketName = s3Domain.split('.')[0];
      bucketNames.add(bucketName)
    }

    console.log(`Found following CF attached bucket names: ${new Array(...bucketNames).join(' ')}`);

    if (bucketNames.size > 1) {
      console.warn("Are you ensure you want to push your artefacts to more then one bucket? Hit Ctr+C to abort now!")
      await new Promise(r => setTimeout(r, 5000));
    }

    console.log("");
    console.log(`Will upload to to buckets from local dir: ${localDirectory}`);
    console.log("");

    for (const bucketName of bucketNames) {
      // 3. Cleanup s3 bucket (i.e. delete all present files)
      await this.cleanupS3Bucket(bucketName)
      console.log("");

      // 4. Upload new files to s3
      await this.uploadDirectoryToS3(localDirectory, bucketName)
        .then(() => console.log(`Upload completed to ${bucketName} bucket`))
        .catch((err) => {
          console.error("Error during upload:", err);
          process.exit(1);
        });
    }

    console.log("");

    // 5. Invalidate Cloudfront caches to ensure new content is served
    for (const id of cfIds) {
      await this.createInvalidation(id)
    }

    console.log("");
    console.log("All done");

    // 6. Send Slack message
    const slack = new IncomingWebhook(this.slackUrl);
    try {
      await slack.send({ text: `successfully deployed UI for domains: ${new Array(...domains).join(', ')}` });
    } catch (error) {
      console.error("Failed to send Slack message:", error.message)
    }
  }
}

export { S3WebsiteDeploy };
