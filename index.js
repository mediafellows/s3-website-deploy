import { S3Client, PutObjectCommand, ListObjectsV2Command } from "@aws-sdk/client-s3";
import { CloudFrontClient, ListDistributionsCommand, GetDistributionCommand, CreateInvalidationCommand } from "@aws-sdk/client-cloudfront";
import { readdir, stat } from "fs/promises";
import { join, relative } from "path";
import * as fs from "fs";

// Cloudfront Client
const cfClient = new CloudFrontClient({ region: "us-east-1" }); // CloudFront is global, but you can still set a default region

// Get Cloudfront Ids for a given domain alias
async function getDistributionsForDomains(cfDomains) {
  const uniqueCfIds = new Set();
  let distributions;
  let dist;
  let marker;
  let cfId;

  for (const domain of cfDomains) {
    console.log(`Looking for domain ${domain} in CloudFront distributions...`);
    cfId = null;

    do {
      // Fetch distributions with the current marker, as results may be paginated
      const command = new ListDistributionsCommand({ Marker: marker });
      distributions = await cfClient.send(command);
      dist = distributions.DistributionList.Items.find((item) => item.Aliases?.Items?.includes(domain));
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
async function getDistribution(distributionId) {
  try {
    const command = new GetDistributionCommand({ Id: distributionId });
    const response = await cfClient.send(command);
    // console.log("Distribution Details:", response.Distribution);
    return response.Distribution;
  } catch (error) {
    console.error("Error getting distribution details:", error);
    process.exit(1);
  }
}

// Create Cloudfront invalidation for given CF id
async function createInvalidation(distributionId) {
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
    const response = await cfClient.send(command);
    console.log("Invalidation created:", response.Invalidation.Id);
  } catch (error) {
    console.error("Error creating invalidation:", error);
  }
}


// AWS S3 Configuration
const region = "us-east-1"; // autodetect?
const s3Client = new S3Client({ region });

/**
 * Recursively upload files from a local directory to S3.
 * @param {string} dir - The local directory path.
 * @param {string} buckeName - bucket name to upload to
 */
async function uploadDirectoryToS3(dir, bucketName) {
  const files = await readdir(dir);
  const s3Prefix = ""

  for (const file of files) {
    const filePath = join(dir, file);
    const fileStat = await stat(filePath);

    if (fileStat.isDirectory()) {
      // Recursively upload subdirectory
      await uploadDirectoryToS3(filePath, join(s3Prefix, file));
    } else {
      // Upload file
      const fileStream = fs.createReadStream(filePath);
      const s3Key = join(s3Prefix, file);

      console.log(`Uploading ${filePath} to s3://${bucketName}/${s3Key}`);

      const uploadParams = {
        Bucket: bucketName,
        Key: s3Key.replace(/\\/g, "/"), // Ensure S3 key uses forward slashes
        Body: fileStream,
      };

      try {
        await s3Client.send(new PutObjectCommand(uploadParams));
        console.log(`Uploaded: ${s3Key}`);
      } catch (error) {
        console.error(`Failed to upload ${s3Key}:`, error);
      }
    }
  }
}

async function cleanupS3Bucket(bucketName) {
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

      const listResponse = await s3Client.send(listCommand);

      if (listResponse.Contents && listResponse.Contents.length > 0) {
        // Print found objects
        listResponse.Contents.forEach((item) => {
          console.log(`Found: ${item.Key} (${item.Size} bytes)`);
        });

        // Prepare objects for deletion
        const objectsToDelete = listResponse.Contents.map((item) => ({ Key: item.Key }));

        // Delete objects
        const deleteCommand = new DeleteObjectsCommand({
          Bucket: bucketName,
          Delete: {
            Objects: objectsToDelete,
          },
        });

        const deleteResponse = await s3Client.send(deleteCommand);
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
      break;
    }
  }

  console.log("Finished cleaning bucket.");
}


// Wrapper method to do all steps
async function deploy(domains, localDirectory) {
  // 1. Find Cloudfront distributions for given list of domains
  const cfIds = await getDistributionsForDomains(domains)

  // 2. Extract bucket names from Cloudfront distributions
  const bucketNames = new Set();
  for (const id of cfIds) {
    const distribution = await getDistribution(id)
    const s3Domain = distribution.DistributionConfig.Origins.Items[0].DomainName;
    const bucketName = s3Domain.split('.')[0];
    bucketNames.add(bucketName)
  }

  console.log(`Found following CF attached bucket names: ${new Array(...bucketNames).join(' ')}`);

  // 3. Cleanup s3 bucket (i.e. delete all present files)
  cleanupS3Bucket(bucketName)

  // 4. Upload new files to s3
  console.log(`Will upload to to buckets from local dir: ${localDirectory}`);
  for (const bucketName of bucketNames) {
    uploadDirectoryToS3(localDirectory, buckeName)
      .then(() => console.log(`Upload completed to ${buckeName}`))
      .catch((err) => console.error("Error during upload:", err));
  }

  // 5. Invalidate Cloudfront caches to ensure new content is served
  for (const id of cfIds) {
    createInvalidation(id)
  }
}

// Example call
// deploy(['test.com'], 'dist/')
