import { S3WebsiteDeploy } from './index.js';

const deployer = new S3WebsiteDeploy('mf_staging', 'us-east-1', 'dummy');

// Tweak values here for testing of methods
//const cfIds = await deployer.getDistributionsForDomains(['test.buyer.mediastore.dev']);

console.log(`CF IDs: ${new Array(...cfIds).join(', ')}`);

// deployer.deploy(['xxxxx'], 'test')
