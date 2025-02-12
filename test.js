import { S3WebsiteDeploy } from './index.js';

const deployer = new S3WebsiteDeploy('mf_production', 'us-east-1', 'dummy');

// Tweak values here for testing of methods
const cfIds = await deployer.getDistributionsForDomains(['DUMMY']);

console.log(`CF IDs: ${new Array(...cfIds).join(', ')}`);
