import { Construct } from 'constructs';
import { RemovalPolicy, Duration, Stack } from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as secretsManager from 'aws-cdk-lib/aws-secretsmanager';
import * as rds from 'aws-cdk-lib/aws-rds';
import * as custom from 'aws-cdk-lib/custom-resources'
import * as iam from 'aws-cdk-lib/aws-iam';

export interface DatabaseProps {
  readonly dbName: string;
  readonly dbAdminUsername: string;
  readonly dbWebUsername: string;
  readonly dbStorageGB: number;
  readonly dbMaxStorageGiB: number;
  readonly dbMultiAZ: boolean;
  readonly dbBackupRetentionDays: number;
  readonly dbDeleteAutomatedBackups: boolean;
  readonly dbPreferredBackupWindow: string;
  readonly dbCloudwatchLogsExports: string[];
  readonly dbIamAuthentication: boolean;
  readonly dbInstanceType: string;
  readonly dbRetentionPolicy: string;
}

export interface CdkRDSResourceProps {
  readonly applicationName: string;
  readonly dbSecurityGroup: ec2.ISecurityGroup;
  readonly vpc: ec2.IVpc;
  readonly databaseProps: DatabaseProps;
  readonly webTierRole: iam.IRole;
  readonly retentionSetting: RemovalPolicy;
}

export class CdkRDSResource extends Construct {
  public readonly rdsInstance: rds.IDatabaseInstance;
  public readonly rdsCredentials: secretsManager.ISecret;
  public readonly rdsCredentialsName: string;

  constructor(scope: Construct, id: string, props: CdkRDSResourceProps) {
    super(scope, id)

    const { applicationName, vpc, dbSecurityGroup, webTierRole, retentionSetting } = props
    const {
      dbName,
      dbAdminUsername,
      dbWebUsername,
      dbStorageGB,
      dbMaxStorageGiB,
      dbMultiAZ,
      dbBackupRetentionDays,
      dbDeleteAutomatedBackups,
      dbPreferredBackupWindow,
      dbCloudwatchLogsExports,
      dbIamAuthentication,
      dbInstanceType
    } = props.databaseProps

    /* 
      Use Secrets Manager to create credentials for the Admin user for the RDS database
      Admin account is only used to create a dbwebusername, which the application uses to connect
      Admin credentials are preserved in Secrets Manager, in case of emergency.
      For now, credentials are not rotated
    */
    const dbCredentialsName = `${applicationName}-database-credentials`
    const dbCredentials = new secretsManager.Secret(this, `${applicationName}-DBCredentialsSecret`, {
      secretName: dbCredentialsName,
      generateSecretString: {
        secretStringTemplate: JSON.stringify({
          username: dbAdminUsername,
        }),
        excludePunctuation: true,
        includeSpace: false,
        generateStringKey: 'password'
      }
    });

    // Define a subnetGroup based on the isolated subnets from the VPC we created
    const rdsSubnetGroup = new rds.SubnetGroup(this, 'rds-subnet-group', {
      vpc: vpc,
      description: 'subnetgroup-db',
      vpcSubnets: {
        subnetType: ec2.SubnetType.PRIVATE_ISOLATED
      }
    })
    rdsSubnetGroup.applyRemovalPolicy(retentionSetting)

    // Define the configuration of the RDS instance
    const rdsConfig: rds.DatabaseInstanceProps = {
      vpc,
      engine: rds.DatabaseInstanceEngine.mysql({ version: rds.MysqlEngineVersion.VER_8_0_25 }),
      instanceType: new ec2.InstanceType(dbInstanceType),
      instanceIdentifier: `${applicationName}`,
      allocatedStorage: dbStorageGB,
      maxAllocatedStorage: dbMaxStorageGiB,
      securityGroups: [dbSecurityGroup],
      credentials: rds.Credentials.fromSecret(dbCredentials), // Get both username and password for Admin user from Secrets manager
      storageEncrypted: true,
      databaseName: dbName,
      multiAz: dbMultiAZ,
      backupRetention: Duration.days(dbBackupRetentionDays), // If set to 0, no backup
      deleteAutomatedBackups: dbDeleteAutomatedBackups,
      preferredBackupWindow: dbPreferredBackupWindow,
      publiclyAccessible: false,
      removalPolicy: retentionSetting,
      cloudwatchLogsExports: dbCloudwatchLogsExports,
      cloudwatchLogsRetention: dbBackupRetentionDays,
      subnetGroup: rdsSubnetGroup,
      iamAuthentication: dbIamAuthentication // Enables IAM authentication for the database
    }

    // create the Database instance, assign it to the public attribute so that the stack can read it from the construct
    this.rdsInstance = new rds.DatabaseInstance(this, `${applicationName}-instance`, rdsConfig);
    this.rdsCredentials = dbCredentials
    this.rdsCredentialsName = dbCredentialsName

    /*
      There is an issue with rdsInstance.grantConnect(myRole); In a nutshell, the permission created, doesn't actually
      create access based on the format defined here: https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/UsingWithRDS.IAMDBAuth.IAMPolicy.html
      
      We still need to add permissions for the web-application to connect to the RDS database with IAM credentials
      A workaround was implemented based on: https://github.com/aws/aws-cdk/issues/11851
      
      For the permissions, we need access to the ResourceId of the instance.
      In a nutshell, we create a custom resource, which calls a Lambda function. 
      This Lambda function calls the describeDBInstances api, and gets the resourceId
      We construct a proper policy, and attach it to the web instances' role.
    */
    if (dbIamAuthentication) {
      const { region, account, stackName } = Stack.of(this)
      const customResourceFnRole = new iam.Role(this, 'AwsCustomResourceRoleInfra', {
        assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com')
      })
      customResourceFnRole.addToPolicy(
        new iam.PolicyStatement({
          resources: [`arn:aws:lambda:${region}:${account}:function:*-ResInit${stackName}`],
          actions: ['lambda:InvokeFunction']
        })
      )
      const dbResourceId = new custom.AwsCustomResource(this, 'RdsInstanceResourceId', {
        onCreate: {
          service: 'RDS',
          action: 'describeDBInstances',
          parameters: {
            DBInstanceIdentifier: this.rdsInstance.instanceIdentifier,
          },
          physicalResourceId: custom.PhysicalResourceId.fromResponse('DBInstances.0.DbiResourceId'),
          outputPaths: ['DBInstances.0.DbiResourceId'],
        },
        policy: custom.AwsCustomResourcePolicy.fromSdkCalls({
          resources: custom.AwsCustomResourcePolicy.ANY_RESOURCE,
        }),
        role: customResourceFnRole
      });
      const resourceId = dbResourceId.getResponseField(
        'DBInstances.0.DbiResourceId'
      )

      const dbUserArn = `arn:aws:rds-db:${region}:${account}:dbuser:${resourceId}/${dbWebUsername}`

      webTierRole.addToPrincipalPolicy(
        new iam.PolicyStatement({
          actions: ['rds-db:connect'],
          resources: [dbUserArn]
        })
      )
    }
  }
}