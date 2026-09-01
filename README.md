# S3 website deploy

Provides a simple deploy method that hides the complexity of deploying new frontend artefacts to an AWS S3 website hosting setup.
Only works if the AWS S3 bucket is fronted by a [multi-tenant CloudFront distribution](https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/distribution-config-options.html#connection-mode). Note that this can be achieved using usual infrastructure provisioners like Terraform, CloudFormation, Ansible etc. and is not the scope of this package.

Call the deploy method with the S3 bucket name and the local directory containing the frontend artefacts. The package finds every multi-tenant CloudFront distribution that uses the bucket and invalidates all distribution tenants attached to those distributions.

This deploy takes care of those steps:

1. Find multi-tenant CloudFront distributions that use the S3 bucket
2. Find all distribution tenants attached to those distributions
3. Clean up the S3 bucket (i.e. delete all present files)
4. Upload new files to the S3 bucket
5. Invalidate every attached distribution tenant to ensure new content is served

## Install and usage

To install from GH repo you need to add this to your `.npmrc` first:

```txt
@mediafellows:registry=https://npm.pkg.github.com/
```

After that you can install the package with either npm or yarn like this:

```sh
npm install @mediafellows/s3-website-deploy
```

Once installed you can include the website deploy method like this:

```javascript
import { S3WebsiteDeploy } from '@mediafellows/s3-website-deploy';

// some other code

// name of the AWS profile configured in ~/.aws/credentials to be used to the deploy
const awsProfile = 'production'
// AWS s3 bucket region
const awsRegion = 'us-east-1'
// Slack secret webhook URL (optional) to send deploy message to
const slackUrl = 'https://hooks.slack.com/services/XXX/YYY/ZZZ'

const deployer = new S3WebsiteDeploy(awsProfile, awsRegion, slackUrl)

// dir with website artefacts to be uploaded to s3
const buildDir = "dist/"

// S3 bucket used as the origin of the multi-tenant CloudFront distribution
const bucketName = 'my-website-assets'

// Run deploy
await deployer.deploy(bucketName, buildDir)
```

This will run the deploy for you, as described above. Your AWS credentials should have the following permissions.

On relevant buckets:

```txt
"s3:List*"
"s3:Get*"
"s3:Put*"
"s3:DeleteObject"
```

On relevant CloudFront distributions and tenants:

```json
"cloudfront:ListDistributionsByConnectionMode"
"cloudfront:ListDistributionTenants"
"cloudfront:CreateInvalidationForDistributionTenant"
```

This module is meant to use configured credential profiles from `~/.aws/credentials`. But setting AWS ENV variables should also work.

## Dev setup

To do development on this package setup things as follows:

1. Install NodeJS in the version specified in .tool-versions (> 24)
2. Run `npm install` to install dependencies
3. Run `npm test` to run the unit test (see test command defined in package.json)
4. Make changes and keep rerunning tests.

For releasing made changes see chapter below.

## Release

To release a new npm package to GitHub npm repo follow these steps:

1. Run `npm run build` to generate build artefacts in dist/ (to support both CommonJS and ESM import/requires)
2. Bump version in package.json
3. Run `npm install` to also update package-lock.json
4. Commit everything to git (`git add . && git commit -m "New version" && git push`)
5. Run `npm publish` pushes the file to the GH npm repo

Now it can be installed in projects with

`npm install -D @mediafellows/s3-website-deploy`

Or with yarn if you prefer that.

Suports `const { S3WebsiteDeploy } = require('@mediafellows/s3-website-deploy')` and `import { S3WebsiteDeploy} from '@mediafellows/s3-website-deploy'`
