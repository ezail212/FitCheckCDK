import { Stack, StackProps, RemovalPolicy } from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';

/**
 * DataStack — the persistence layer for FitCheck.
 *
 * Four DynamoDB tables (see ProjectInfra.md §3):
 *   - Users    : coaches + students (one person = one item), GSI byCoach
 *   - Sessions : planned-then-performed workout records, GSI byCoachDate
 *   - Drafts   : transient LLM-draft tasks, auto-expired via TTL
 *   - Assets   : pointers to S3 blobs (videos/photos) — used later
 *
 * On-demand (PAY_PER_REQUEST) billing: no capacity to manage, scales to zero,
 * cheap for a side project while still handling growth.
 */
export class DataStack extends Stack {
  public readonly usersTable: dynamodb.Table;
  public readonly sessionsTable: dynamodb.Table;
  public readonly draftsTable: dynamodb.Table;
  public readonly assetsTable: dynamodb.Table;

  constructor(scope: Construct, id: string, props?: StackProps) {
    super(scope, id, props);

    // NOTE: DESTROY is convenient during early development (destroying the stack
    // removes the tables). Switch the durable tables (Users, Sessions) to RETAIN
    // before this holds real user data. Drafts/Assets can stay DESTROY.
    const removalPolicy = RemovalPolicy.DESTROY;

    // --- Users -------------------------------------------------------------
    // PK = userId. Coaches and students are distinct items; `roles` tells them
    // apart. GSI byCoach answers "all students of coach X" (and self-coaching,
    // where coachId == userId).
    this.usersTable = new dynamodb.Table(this, 'UsersTable', {
      tableName: 'FitCheck-Users',
      partitionKey: { name: 'userId', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy,
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
    });
    this.usersTable.addGlobalSecondaryIndex({
      indexName: 'byCoach',
      partitionKey: { name: 'coachId', type: dynamodb.AttributeType.STRING },
      projectionType: dynamodb.ProjectionType.ALL,
    });

    // --- Sessions ----------------------------------------------------------
    // PK = studentId, SK = sessionDate#sessionId  -> cheap per-student date-range
    // queries. GSI byCoachDate answers "all upcoming sessions across ALL of a
    // coach's students, sorted by date" for the coach dashboard.
    this.sessionsTable = new dynamodb.Table(this, 'SessionsTable', {
      tableName: 'FitCheck-Sessions',
      partitionKey: { name: 'studentId', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'sk', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy,
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
    });
    this.sessionsTable.addGlobalSecondaryIndex({
      indexName: 'byCoachDate',
      partitionKey: { name: 'coachId', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'sk', type: dynamodb.AttributeType.STRING },
      projectionType: dynamodb.ProjectionType.ALL,
    });

    // --- Drafts ------------------------------------------------------------
    // PK = draftId. Transient LLM tasks (QUEUED -> IN_PROGRESS -> COMPLETED/FAILED).
    // `ttl` (epoch seconds) lets DynamoDB auto-delete stale drafts for free.
    this.draftsTable = new dynamodb.Table(this, 'DraftsTable', {
      tableName: 'FitCheck-Drafts',
      partitionKey: { name: 'draftId', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy,
      timeToLiveAttribute: 'ttl',
    });

    // --- Assets ------------------------------------------------------------
    // PK = studentId, SK = assetId  -> list a student's media pointers. The S3
    // objects themselves live in a bucket (added later); this table holds metadata.
    this.assetsTable = new dynamodb.Table(this, 'AssetsTable', {
      tableName: 'FitCheck-Assets',
      partitionKey: { name: 'studentId', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'assetId', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy,
    });
  }
}
