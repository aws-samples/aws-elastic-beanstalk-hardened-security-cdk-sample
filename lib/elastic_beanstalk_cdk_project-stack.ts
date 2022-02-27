import { Stack, RemovalPolicy, App, Duration, CfnOutput, Token, CfnResource } from 'aws-cdk-lib';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as elasticbeanstalk from 'aws-cdk-lib/aws-elasticbeanstalk';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as s3Deploy from 'aws-cdk-lib/aws-s3-deployment';

import { DockerImageCode } from 'aws-cdk-lib/aws-lambda'
import { CdkResourceInitializer } from './rds_initialiser';
import { CdkRDSResource, DatabaseProps } from './rds_infrastructure';

export interface ElasticBeanstalkCdkStackProps {
  readonly instanceType: string;
  readonly applicationName: string;
  readonly vpcName: string;
  readonly vpcCidr: string;
  readonly loadbalancerInboundCIDR: string;
  readonly loadbalancerOutboundCIDR: string;
  readonly webserverOutboundCIDR: string;
  readonly zipFileName: string;
  readonly solutionStackName: string;
  readonly managedActionsEnabled: string;
  readonly updateLevel: string;
  readonly preferredUpdateStartTime: string;
  readonly streamLogs: string;
  readonly deleteLogsOnTerminate: string;
  readonly logRetentionDays: string;
  readonly loadBalancerType: string;
  readonly lbHTTPSEnabled: boolean;
  readonly lbHTTPSCertificateArn: string; 
  readonly lbSSLPolicy: string;
  readonly databaseSettings: DatabaseProps;
}

export class ElasticBeanstalkCdkStack extends Stack {
  constructor(scope: App, id: string, props: ElasticBeanstalkCdkStackProps) {
    super(scope, id);
    const {
      applicationName,
      instanceType,
      vpcName,
      vpcCidr,
      loadbalancerInboundCIDR,
      loadbalancerOutboundCIDR,
      webserverOutboundCIDR,
      zipFileName,
      solutionStackName,
      managedActionsEnabled,
      updateLevel,
      preferredUpdateStartTime,
      streamLogs,
      deleteLogsOnTerminate,
      logRetentionDays,
      loadBalancerType,
      lbHTTPSEnabled,
      lbHTTPSCertificateArn,
      lbSSLPolicy,
    } = props

    if (lbHTTPSEnabled && lbHTTPSCertificateArn === "") {
      throw new Error("Please provide a certificate ARN in cdk.json, or disable HTTPS for testing purposes");
    }

    console.log("Configuration settings: ", props)

    const { dbWebUsername, dbName, dbRetentionPolicy } = props.databaseSettings // get some database settings

    let retentionPolicy: RemovalPolicy;
    switch (dbRetentionPolicy) {
      case "destroy": retentionPolicy = RemovalPolicy.DESTROY; break;
      case "snapshot": retentionPolicy = RemovalPolicy.SNAPSHOT; break;
      default: retentionPolicy = RemovalPolicy.RETAIN
    }

    // Create an encrypted bucket for deployments and log storage
    // S3 Bucket needs a specific format for deployment + logs: https://docs.aws.amazon.com/elasticbeanstalk/latest/dg/AWSHowTo.S3.html
    const encryptedBucket = new s3.Bucket(this, 'EBEncryptedBucket', {
      bucketName: `elasticbeanstalk-${this.region}-${this.account}`,
      encryption: s3.BucketEncryption.S3_MANAGED,
      serverAccessLogsPrefix: 'server_access_logs',
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true
    })

    /*
      Create a VPC with three subnets, spread across two AZs:
      1. Private subnet with route to NAT Gateway for the webinstances
      2. Private subnet without NAT Gateway (isolated) for the database instance
      3. Public subnet with Internet Gateway + NAT Gateway for public access for ALB and NAT Gateway access from Web instances
      
      Store VPC flow logs in the encrypted bucket we created above
    */
    const vpc = new ec2.Vpc(this, vpcName, {
      natGateways: 1,
      maxAzs: 2,
      cidr: vpcCidr,
      flowLogs: {
        's3': {
          destination: ec2.FlowLogDestination.toS3(encryptedBucket, 'vpc-flow-logs'),
          trafficType: ec2.FlowLogTrafficType.ALL
        }
      },
      subnetConfiguration: [
        {
          name: 'private-with-nat',
          subnetType: ec2.SubnetType.PRIVATE_WITH_NAT,
        },
        {
          name: 'private-isolated',
          subnetType: ec2.SubnetType.PRIVATE_ISOLATED,
        },
        {
          name: 'public',
          subnetType: ec2.SubnetType.PUBLIC,
        }
      ]
    })

    // Upload the example ZIP file to the deployment bucket 
    const appDeploymentZip = new s3Deploy.BucketDeployment(this, "DeployZippedApplication", {
      sources: [s3Deploy.Source.asset(`${__dirname}/../src/deployment_zip`)],
      destinationBucket: encryptedBucket
    });

    // Define a new Elastic Beanstalk application
    const app = new elasticbeanstalk.CfnApplication(this, 'Application', {
      applicationName: applicationName,
    });

    // Create role for the web-instances
    const webtierRole = new iam.Role(this, `${applicationName}-webtier-role`, {
      assumedBy: new iam.ServicePrincipal('ec2.amazonaws.com'),
    });

    // Add a managed policy for the ELastic Beanstalk web-tier to the webTierRole
    const managedPolicy = iam.ManagedPolicy.fromAwsManagedPolicyName('AWSElasticBeanstalkWebTier')
    webtierRole.addManagedPolicy(managedPolicy);

    // Create an instance profile for the web-instance role
    const ec2ProfileName = `${applicationName}-EC2WebInstanceProfile`
    const ec2InstanceProfile = new iam.CfnInstanceProfile(this, ec2ProfileName, {
      instanceProfileName: ec2ProfileName,
      roles: [webtierRole.roleName]
    });

    /*
      If you use the default ServiceRole (i.e. you don't define a custom one), and then want to enable Managed Updates, you'll get the following error:
      You can't enable managed platform updates when your environment uses the service-linked role 'AWSServiceRoleForElasticBeanstalk'. 
      Select a service role that has the 'AWSElasticBeanstalkManagedUpdatesCustomerRolePolicy' managed policy.
      
      For this reason, I'm creating a custom ServiceRole, which has the same permissions as the default Service role created by Elastic Beanstalk
     */
    const policyJson = require('./service_role_policy.json')
    const serviceRolePolicy = new iam.Policy(this, 'serviceRolePolicy', {
      policyName: 'BeanstalkServiceRolePolicy',
      document: iam.PolicyDocument.fromJson(policyJson)
    })

    const ebServiceRole = new iam.Role(this, 'ebServiceRole', {
      roleName: "aws-elasticbeanstalk-service-role",
      assumedBy: new iam.ServicePrincipal('elasticbeanstalk.amazonaws.com'),
    })
    ebServiceRole.attachInlinePolicy(serviceRolePolicy)


    // Create Security Group for load balancer
    const lbSecurityGroup = new ec2.SecurityGroup(this, 'LbSecurityGroup', {
      vpc: vpc,
      description: "Security Group for the Load Balancer",
      securityGroupName: "lb-security-group-name",
      allowAllOutbound: false
    })

    // Determine if HTTP or HTTPS port should be used for LB
    const lbPort = lbHTTPSEnabled === true ? 443 : 80

    // Allow Security Group outbound traffic for load balancer
    lbSecurityGroup.addEgressRule(
      ec2.Peer.ipv4(loadbalancerOutboundCIDR),
      ec2.Port.tcp(lbPort),
      `Allow outgoing traffic over port ${lbPort}`
    );

    // Allow Security Group inbound traffic for load balancer
    lbSecurityGroup.addIngressRule(
      ec2.Peer.ipv4(loadbalancerInboundCIDR),
      ec2.Port.tcp(lbPort),
      `Allow incoming traffic over port ${lbPort}`
    );

    // Create Security Group for web instances
    const webSecurityGroup = new ec2.SecurityGroup(this, 'WebSecurityGroup', {
      vpc: vpc,
      description: "Security Group for the Web instances",
      securityGroupName: "web-security-group",
      allowAllOutbound: false
    })

    // Allow Security Group outbound traffic over port 80 instances
    webSecurityGroup.addEgressRule(
      ec2.Peer.ipv4(webserverOutboundCIDR),
      ec2.Port.tcp(80),
      'Allow outgoing traffic over port 80'
    );

    // Allow Security Group inbound traffic over port 80 from the Load Balancer security group
    webSecurityGroup.connections.allowFrom(
      new ec2.Connections({
        securityGroups: [lbSecurityGroup]
      }),
      ec2.Port.tcp(80)
    )

    // Create Security Group for Database (+ replica)
    const dbSecurityGroup = new ec2.SecurityGroup(this, 'DbSecurityGroup', {
      vpc: vpc,
      description: "Security Group for the RDS instance",
      securityGroupName: "db-security-group",
      allowAllOutbound: false
    })

    /*
      https://issueexplorer.com/issue/aws/aws-cdk/17205 - retain isolated subnets
      If we want to keep the DB, we need to maintain the isolated subnets and corresponding VPC.
      There is no easy way to keep the isolated subnets and destroy all the other resources in the VPC (IGW, NAT, EIP, etc.)
      Therefore, we're going to keep the whole VPC in case we want to keep the DB alive when running CDK destroy. 
    */
    if (retentionPolicy === RemovalPolicy.RETAIN) {
      dbSecurityGroup.applyRemovalPolicy(retentionPolicy)
      vpc.applyRemovalPolicy(retentionPolicy)
      vpc.node.findAll().forEach(node => node instanceof CfnResource && node.applyRemovalPolicy(retentionPolicy))
    }


    // Allow inbound traffic on port 3306 from the web instances
    dbSecurityGroup.connections.allowFrom(
      new ec2.Connections({
        securityGroups: [webSecurityGroup]
      }),
      ec2.Port.tcp(3306)
    )

    /*
      Note for code above ^: We didn't select outbound traffic for DB Security Group above.
      Setting no outbound will yield: "out -> ICMP 252-86 -> 255.255.255.255/32" to be added to the security group.
      This is used in order to disable the "all traffic" default of Security Groups. No machine can ever actually have 
      the 255.255.255.255 IP address, but in order to lock it down even more we'll restrict to a nonexistent ICMP traffic type.
      Source: https://github.com/aws/aws-cdk/issues/1430
    */

    // Create the RDS instance from the custom resource defined in 'rds_infrastructure.ts'
    const rdsResource = new CdkRDSResource(this, 'rdsResource', {
      applicationName,
      dbSecurityGroup,
      vpc: vpc,
      databaseProps: props.databaseSettings,
      webTierRole: webtierRole,
      retentionSetting: retentionPolicy
    });

    // get variables from rds resource
    const { rdsInstance, rdsCredentials, rdsCredentialsName } = rdsResource

    /*
      Source for initialiser:
      https://aws.amazon.com/blogs/infrastructure-and-automation/use-aws-cdk-to-initialize-amazon-rds-instances/
      Initialiser is a Custom Resource which runs a function which executes a Lambda function to create a user
      in the RDS database with IAM authentication. Lambda function can be deleted after first execution
    */
    const initializer = new CdkResourceInitializer(this, 'MyRdsInit', {
      config: {
        dbCredentialsName: rdsCredentialsName,
        dbWebUsername,
        dbName
      },
      fnLogRetention: logs.RetentionDays.FIVE_MONTHS,
      fnCode: DockerImageCode.fromImageAsset(`${__dirname}/rds-init-fn-code`, {}),
      fnTimeout: Duration.minutes(2),
      fnSecurityGroups: [],
      vpc
    })

    // Add a dependency for the initialiser to make sure it runs only after the RDS instance has been created
    initializer.customResource.node.addDependency(rdsInstance)

    // Allow the initializer function to connect to the RDS instance
    rdsInstance.connections.allowFrom(initializer.function, ec2.Port.tcp(3306))

    // Allow initializer function to read RDS instance creds secret
    rdsCredentials.grantRead(initializer.function)

    // Output the output of the initialiser, to make sure that the query was executed properly
    const output = new CfnOutput(this, 'RdsInitFnResponse', {
      value: Token.asString(initializer.response)
    })

    /*
      CREATING THE ELASTIC BEANSTALK APPLICATION 
    */

    // Get the public and private subnets to deploy Elastic Beanstalk ALB and web servers in.
    const publicSubnets = vpc.selectSubnets({ subnetType: ec2.SubnetType.PUBLIC }).subnets
    const privateWebSubnets = vpc.selectSubnets({ subnetType: ec2.SubnetType.PRIVATE_WITH_NAT }).subnets

    // A helper function to create a comma separated string from subnets ids
    const createCommaSeparatedList = function (subnets: ec2.ISubnet[]): string {
      return subnets.map((subnet: ec2.ISubnet) => subnet.subnetId).toString()
    }

    const webserverSubnets = createCommaSeparatedList(privateWebSubnets)
    const lbSubnets = createCommaSeparatedList(publicSubnets)

    // Define settings for the Elastic Beanstalk application
    // Documentation for settings: https://docs.aws.amazon.com/elasticbeanstalk/latest/dg/command-options-general.html
    const serviceLinkedRole = 'AWSServiceRoleForElasticBeanstalkManagedUpdates'
    var ebSettings = [
      ['aws:elasticbeanstalk:environment', 'LoadBalancerType', loadBalancerType],                                 // Set the load balancer type (e.g. 'application' for ALB)
      ['aws:elasticbeanstalk:environment', 'ServiceRole', ebServiceRole.roleArn],                                 // Set the Service Role
      ['aws:autoscaling:launchconfiguration', 'InstanceType', instanceType],                                      // Set instance type for web tier
      ['aws:autoscaling:launchconfiguration', 'IamInstanceProfile', ec2InstanceProfile.attrArn],                  // Set IAM Instance Profile for web tier
      ['aws:autoscaling:launchconfiguration', 'SecurityGroups', webSecurityGroup.securityGroupId],                // Set Security Group for web tier
      ['aws:ec2:vpc', 'VPCId', vpc.vpcId],                                                                        // Deploy resources in VPC created earlier
      ['aws:ec2:vpc', 'Subnets', webserverSubnets],                                                               // Deploy Web tier instances in private subnets
      ['aws:ec2:vpc', 'ELBSubnets', lbSubnets],                                                                   // Deploy Load Balancer in public subnets  
      ['aws:elbv2:loadbalancer', 'SecurityGroups', lbSecurityGroup.securityGroupId],                              // Attach Security Group to Load Balancer              
      ['aws:elasticbeanstalk:managedactions', 'ServiceRoleForManagedUpdates', serviceLinkedRole],                 // Select Service Role for Managed Updates (Elastic Beanstalk will automatically create)
      ['aws:elasticbeanstalk:managedactions', 'ManagedActionsEnabled', managedActionsEnabled],                    // Whether or not to enable managed actions
      ['aws:elasticbeanstalk:managedactions:platformupdate', 'UpdateLevel', updateLevel],                         // Set the update level (e.g. 'patch' or 'minor')
      ['aws:elasticbeanstalk:managedactions', 'PreferredStartTime', preferredUpdateStartTime],                    // Set preferred start time for managed updates
      ['aws:elasticbeanstalk:cloudwatch:logs', 'StreamLogs', streamLogs],                                         // Whether or not to stream logs to CloudWatch
      ['aws:elasticbeanstalk:cloudwatch:logs', 'DeleteOnTerminate', deleteLogsOnTerminate],                       // Whether or not to delete log groups when Elastic Beanstalk environment is terminated
      ['aws:elasticbeanstalk:cloudwatch:logs', 'RetentionInDays', logRetentionDays],                              // Number of days logs should be retained
      ['aws:elasticbeanstalk:hostmanager', 'LogPublicationControl', 'true'],                                      // Enable Logging to be stored in S3
      ['aws:elasticbeanstalk:application:environment', 'RDS_HOSTNAME', rdsInstance.dbInstanceEndpointAddress],    // Define Env Variable for HOSTNAME
      ['aws:elasticbeanstalk:application:environment', 'RDS_PORT', rdsInstance.dbInstanceEndpointPort],           // Define Env Variable for PORT
      ['aws:elasticbeanstalk:application:environment', 'RDS_USERNAME', props.databaseSettings.dbWebUsername],     // Define Env Variable for DB username to connect (web tier)
      ['aws:elasticbeanstalk:application:environment', 'RDS_DATABASE', props.databaseSettings.dbName],            // Define Env Variable for DB name (defined when RDS db created)
      ['aws:elasticbeanstalk:application:environment', 'REGION', this.region],                                    // Define Env Variable for Region
    ]

    if (lbHTTPSEnabled === true) {
      const sslPolicy = lbSSLPolicy || "ELBSecurityPolicy-FS-1-2-Res-2020-10"
      const httpsSettings = [
        ['aws:elbv2:listener:default', 'ListenerEnabled', "false"],                         // Disable the default HTTP listener
        ['aws:elbv2:listener:443', 'ListenerEnabled', "true"],                              // Create a new HTTPS listener on port 443
        ['aws:elbv2:listener:443', 'SSLCertificateArns', lbHTTPSCertificateArn],            // Attach the certificate for the custom domain
        ['aws:elbv2:listener:443', 'SSLPolicy', sslPolicy],                                 // Specifies the TLS policy
        ['aws:elbv2:listener:443', 'Protocol', "HTTPS"],                                    // Sets the protocol for the listener to HTTPS
      ]
      ebSettings = ebSettings.concat(httpsSettings)
    }
    /* Map settings created above, to the format required for the Elastic Beanstalk OptionSettings 
      [
        { 
        namespace: "",
        optionName: "",
        value: ""
        },
        ....
      ]
    */
    const optionSettingProperties: elasticbeanstalk.CfnEnvironment.OptionSettingProperty[] = ebSettings.map(
      setting => ({ namespace: setting[0], optionName: setting[1], value: setting[2] })
    )

    // Create an app version based on the sample application (from https://docs.aws.amazon.com/elasticbeanstalk/latest/dg/nodejs-getstarted.html)
    const appVersionProps = new elasticbeanstalk.CfnApplicationVersion(this, 'EBAppVersion', {
      applicationName: applicationName,
      sourceBundle: {
        s3Bucket: encryptedBucket.bucketName,
        s3Key: zipFileName,
      },
    });

    // Create Elastic Beanstalk environment
    new elasticbeanstalk.CfnEnvironment(this, 'EBEnvironment', {
      environmentName: `${applicationName}-env`,
      applicationName: applicationName,
      solutionStackName: solutionStackName,
      versionLabel: appVersionProps.ref,
      optionSettings: optionSettingProperties,
    });

    // Make sure we've initialised DB before we deploy EB
    appVersionProps.node.addDependency(output)

    // Ensure the app and the example ZIP file exists before adding a version 
    appVersionProps.node.addDependency(appDeploymentZip)
    appVersionProps.addDependsOn(app);
  }
}
