# S3 website deploy

Provides a simple deploy method that hides all the complexity of deploying new frotend artefacts to a typical AWs S3 website hosting setup.
Only works if the [s3-website setup](https://docs.aws.amazon.com/AmazonS3/latest/userguide/HostingWebsiteOnS3Setup.html) is fronted by [Cloudfront](https://repost.aws/knowledge-center/cloudfront-serve-static-website).
Note that this can be achieved using usual infrastructure provisioners like Terraform, Cloudformation, Ansible etc. and is not the scope of this package.

All you have to to is to call the deploy method with the domain name(s) you want to update (i.e. Cloudfront alias) and the local dir of the Frontend
artefacts that should be copied to S3.

This deploy takes care of those steps:
1. Find Cloudfront distributions for given domain(s)
2. Extract bucket names from Cloudfront distribution(s)
3. Cleanup of S3 bucket (i.e. delete all present files)
4. Upload new files to S3 bucket(s)
5. Invalidates Cloudfront cache(s) to ensure new content is served

You can provide a list of domains as you might want to upload the same artefacts for multiple Cloudfront distributions (or even buckets), in case you serve them with distributions for TLS cert reasons.

## Install and usage

To install from GH repo you need to add this to your `.npmrc` first:
```
@mediafellows:registry=https://npm.pkg.github.com/
```

After that you can install the package with either npm or yarn like this:
```
npm install @mediafellows/s3-website-deploy@1.0.0
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

const deployer = new S3WebsiteDeploy.new(awsProfile, awsRegion, slackUrl)

// dir with website artefacts to be uploaded to s3
const buildDir = "dist/"

// domains used to select all the Cloudfront distros in question, one domain per CF distro is enough to select them
const domains = ['my-domain.bar', 'another-doman.com']

// Run deploy
deployer.deploy(domains, buildDir)
```

This will run the deploy for you, as desribed above. You AWS credentials should have the following permissions.

On relevant buckets:
```
"s3:List*"
"s3:Get*"
"s3:Put*"
"s3:DeleteObject"
```

On relevant Cloudfront distribtions:
```
"cloudfront:CreateInvalidation"
"cloudfront:GetDistribution"
"cloudfront:GetDistributionConfig"
"cloudfront:GetInvalidation"
"cloudfront:List*"
```

This module is meant to use configured credential profiles from `~/.aws/credentials`. But setting AWS ENV variables should also work.
