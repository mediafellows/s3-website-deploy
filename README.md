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
