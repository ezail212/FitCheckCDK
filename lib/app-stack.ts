import { Stack, StackProps, Duration, RemovalPolicy, CfnOutput } from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as cognito from 'aws-cdk-lib/aws-cognito';
import * as apigateway from 'aws-cdk-lib/aws-apigateway';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';

export interface AppStackProps extends StackProps {
  usersTable: dynamodb.ITable;
  sessionsTable: dynamodb.ITable;
  draftsTable: dynamodb.ITable;
}

/**
 * AppStack — Cognito + API Gateway + Lambda handlers (see ProjectInfra.md §6).
 *
 * This first slice wires one authenticated resource end-to-end:
 *   Cognito (coach login) -> API Gateway (Cognito authorizer) -> Python Lambda -> Users table
 *   GET/POST /students
 *
 * Later steps add the remaining CRUD routes, the SQS-backed draft flow, and the
 * worker Lambda into this same stack.
 */
export class AppStack extends Stack {
  public readonly api: apigateway.RestApi;
  public readonly userPool: cognito.UserPool;

  constructor(scope: Construct, id: string, props: AppStackProps) {
    super(scope, id, props);

    // --- Cognito: coach identities --------------------------------------
    this.userPool = new cognito.UserPool(this, 'CoachUserPool', {
      userPoolName: 'FitCheck-Coaches',
      selfSignUpEnabled: true,
      signInAliases: { email: true },
      autoVerify: { email: true },
      standardAttributes: {
        email: { required: true, mutable: false },
        fullname: { required: false, mutable: true },
      },
      passwordPolicy: {
        minLength: 8,
        requireLowercase: true,
        requireUppercase: true,
        requireDigits: true,
      },
      accountRecovery: cognito.AccountRecovery.EMAIL_ONLY,
      // DESTROY while iterating; switch to RETAIN before real coaches sign up.
      removalPolicy: RemovalPolicy.DESTROY,
    });

    // SPA client: no secret (browsers can't keep one), SRP + password auth.
    const userPoolClient = this.userPool.addClient('WebClient', {
      userPoolClientName: 'FitCheck-Web',
      authFlows: { userSrp: true, userPassword: true },
      generateSecret: false,
    });

    // --- Lambda: students handler (Python) ------------------------------
    // Absolute path to the backend source, from .env (see .env.example).
    const backendSrc = process.env.LAMBDA_PATH;
    if (!backendSrc) {
      throw new Error('LAMBDA_PATH is not set. Copy .env.example to .env and set it.');
    }
    const studentsFn = new lambda.Function(this, 'StudentsFn', {
      functionName: 'FitCheck-Students',
      runtime: lambda.Runtime.PYTHON_3_12,
      handler: 'handlers.students.handler',
      code: lambda.Code.fromAsset(backendSrc),
      timeout: Duration.seconds(10),
      memorySize: 256,
      environment: {
        USERS_TABLE: props.usersTable.tableName,
      },
    });
    // Grants CRUD on the table AND its indexes (needed for the byCoach query).
    props.usersTable.grantReadWriteData(studentsFn);

    // --- API Gateway + Cognito authorizer -------------------------------
    this.api = new apigateway.RestApi(this, 'Api', {
      restApiName: 'FitCheck-Api',
      description: 'FitCheck coach API',
      deployOptions: { stageName: 'v1' },
      defaultCorsPreflightOptions: {
        allowOrigins: apigateway.Cors.ALL_ORIGINS, // tighten to the SPA origin later
        allowMethods: apigateway.Cors.ALL_METHODS,
        allowHeaders: ['Content-Type', 'Authorization'],
      },
    });

    const authorizer = new apigateway.CognitoUserPoolsAuthorizer(this, 'CognitoAuthorizer', {
      cognitoUserPools: [this.userPool],
    });
    const auth = {
      authorizer,
      authorizationType: apigateway.AuthorizationType.COGNITO,
    };

    const studentsIntegration = new apigateway.LambdaIntegration(studentsFn);
    const students = this.api.root.addResource('students');
    students.addMethod('GET', studentsIntegration, auth);
    students.addMethod('POST', studentsIntegration, auth);

    // --- Outputs (used by the frontend config later) --------------------
    new CfnOutput(this, 'ApiUrl', { value: this.api.url });
    new CfnOutput(this, 'UserPoolId', { value: this.userPool.userPoolId });
    new CfnOutput(this, 'UserPoolClientId', { value: userPoolClient.userPoolClientId });
    new CfnOutput(this, 'Region', { value: this.region });
  }
}
