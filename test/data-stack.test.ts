import * as cdk from 'aws-cdk-lib';
import { Template, Match } from 'aws-cdk-lib/assertions';
import { DataStack } from '../lib/data-stack';

describe('DataStack', () => {
  const app = new cdk.App();
  const stack = new DataStack(app, 'TestDataStack', {
    env: { account: '123456789012', region: 'us-west-2' },
  });
  const template = Template.fromStack(stack);

  test('creates four DynamoDB tables', () => {
    template.resourceCountIs('AWS::DynamoDB::Table', 4);
  });

  test('all tables use on-demand billing', () => {
    const tables = template.findResources('AWS::DynamoDB::Table');
    Object.values(tables).forEach((t: any) => {
      expect(t.Properties.BillingMode).toBe('PAY_PER_REQUEST');
    });
  });

  test('Users table has byCoach GSI', () => {
    template.hasResourceProperties('AWS::DynamoDB::Table', {
      TableName: 'FitCheck-Users',
      GlobalSecondaryIndexes: Match.arrayWith([
        Match.objectLike({ IndexName: 'byCoach' }),
      ]),
    });
  });

  test('Sessions table has byCoachDate GSI with date sort key', () => {
    template.hasResourceProperties('AWS::DynamoDB::Table', {
      TableName: 'FitCheck-Sessions',
      GlobalSecondaryIndexes: Match.arrayWith([
        Match.objectLike({
          IndexName: 'byCoachDate',
          KeySchema: Match.arrayWith([
            { AttributeName: 'coachId', KeyType: 'HASH' },
            { AttributeName: 'sk', KeyType: 'RANGE' },
          ]),
        }),
      ]),
    });
  });

  test('Drafts table has TTL enabled on `ttl`', () => {
    template.hasResourceProperties('AWS::DynamoDB::Table', {
      TableName: 'FitCheck-Drafts',
      TimeToLiveSpecification: { AttributeName: 'ttl', Enabled: true },
    });
  });
});