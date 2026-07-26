#!/usr/bin/env node
import * as dotenv from 'dotenv';
import * as cdk from 'aws-cdk-lib';
import { DataStack } from '../lib/data-stack';
import { AppStack } from '../lib/app-stack';

// Load .env (LAMBDA_PATH, FRONTEND_PATH, region/account) before instantiating stacks.
dotenv.config();

const app = new cdk.App();

// Region from .env (defaults to us-west-2). Account is taken from the current
// CLI credentials at synth/deploy time unless CDK_DEFAULT_ACCOUNT is set.
const env: cdk.Environment = {
  account: process.env.CDK_DEFAULT_ACCOUNT,
  region: process.env.CDK_DEFAULT_REGION || 'us-west-2',
};

const data = new DataStack(app, 'FitCheck-DataStack', { env });

new AppStack(app, 'FitCheck-AppStack', {
  env,
  usersTable: data.usersTable,
  sessionsTable: data.sessionsTable,
  draftsTable: data.draftsTable,
});