const { S3WebsiteDeploy } = require('./dist/index.cjs');


const deployer = new S3WebsiteDeploy('mf_staging', 'us-east-1', 'dummy');
// deployer.deploy(['xxx'], 'test');
