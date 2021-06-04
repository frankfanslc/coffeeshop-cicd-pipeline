"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.CoffeeShopCodePipeline = void 0;
const cdk = require("@aws-cdk/core");
const ecr = require("@aws-cdk/aws-ecr");
const iam = require("@aws-cdk/aws-iam");
const s3 = require("@aws-cdk/aws-s3");
const ec2 = require("@aws-cdk/aws-ec2");
const codebuild = require("@aws-cdk/aws-codebuild");
const codepipeline = require("@aws-cdk/aws-codepipeline");
const codepipeline_actions = require("@aws-cdk/aws-codepipeline-actions");
const ecs = require("@aws-cdk/aws-ecs");
const ecsPatterns = require("@aws-cdk/aws-ecs-patterns");
const codecommit = require("@aws-cdk/aws-codecommit");
const aws_events_targets_1 = require("@aws-cdk/aws-events-targets");
const core_1 = require("@aws-cdk/core");
const dynamodb = require("@aws-cdk/aws-dynamodb");
const aws_events_1 = require("@aws-cdk/aws-events");
const ssm = require("@aws-cdk/aws-ssm");
const aws_ecs_1 = require("@aws-cdk/aws-ecs");
const DOCKER_IMAGE_PREFIX = 'solid-humank-coffeeshop/orders-web';
const CODECOMMIT_REPO_NAME = 'EventStormingWorkshop';
class CoffeeShopCodePipeline extends cdk.Stack {
    // @ts-ignore
    constructor(scope, id, props) {
        super(scope, id, props);
        // Create a VPC
        const vpc = new ec2.Vpc(this, 'CoffeeShopVPC', {
            cidr: '10.0.0.0/16',
            natGateways: 1
        });
        this.ecrRepository = new ecr.Repository(this, 'Repository', {
            repositoryName: DOCKER_IMAGE_PREFIX,
            removalPolicy: cdk.RemovalPolicy.DESTROY
        });
        const buildRole = new iam.Role(this, 'CodeBuildIamRole', {
            assumedBy: new iam.ServicePrincipal('codebuild.amazonaws.com')
        });
        buildRole.addManagedPolicy(iam.ManagedPolicy.fromAwsManagedPolicyName("AWSLambdaFullAccess"));
        buildRole.addManagedPolicy(iam.ManagedPolicy.fromAwsManagedPolicyName("AmazonAPIGatewayAdministrator"));
        buildRole.addToPolicy(new iam.PolicyStatement({
            resources: ['*'],
            actions: ['cloudformation:*']
        }));
        buildRole.addToPolicy(new iam.PolicyStatement({
            resources: ['*'],
            actions: ['iam:*']
        }));
        buildRole.addToPolicy(new iam.PolicyStatement({
            resources: ['*'],
            actions: ['ecr:GetAuthorizationToken']
        }));
        buildRole.addToPolicy(new iam.PolicyStatement({
            resources: [`${this.ecrRepository.repositoryArn}*`],
            actions: ['ecr:*']
        }));
        // ECR LifeCycles
        // repository.addLifecycleRule({ tagPrefixList: ['prod'], maxImageCount: 9999 });
        this.ecrRepository.addLifecycleRule({ maxImageAge: cdk.Duration.days(30) });
        const defaultSource = codebuild.Source.gitHub({
            owner: 'humank',
            repo: 'EventStormingWorkShop',
            webhook: true,
            webhookFilters: [
                codebuild.FilterGroup.inEventOf(codebuild.EventAction.PUSH).andBranchIs('master'),
            ],
        });
        let bucketName = 'coffeeshop-' + Math.random().toString(36).substring(7);
        const coffeeShopBucket = new s3.Bucket(this, 'CoffeeShopBucket', {
            bucketName: bucketName,
        });
        coffeeShopBucket.grantPut(buildRole);
        coffeeShopBucket.grantRead(buildRole);
        coffeeShopBucket.grantReadWrite(buildRole);
        coffeeShopBucket.grantWrite(buildRole);
        new codebuild.Project(this, 'CodeBuildProject', {
            role: buildRole,
            source: defaultSource,
            // Enable Docker AND custom caching
            cache: codebuild.Cache.local(codebuild.LocalCacheMode.DOCKER_LAYER, codebuild.LocalCacheMode.CUSTOM),
            environment: {
                buildImage: codebuild.LinuxBuildImage.AMAZON_LINUX_2,
                privileged: true,
            },
            buildSpec: codebuild.BuildSpec.fromObject({
                version: '0.2',
                phases: {
                    install: {
                        'runtime-versions': {
                            java: 'corretto11'
                        }
                    },
                    build: {
                        commands: [
                            'echo "Build all modules"',
                            'echo "Run Maven clean install to have all the required jars in local .m2 repository"',
                            'cd sources/coffeeshop',
                            'mvn clean install -Dmaven.test.skip=true'
                        ]
                    },
                    post_build: {
                        commands: [
                            'TAG=${CODEBUILD_RESOLVED_SOURCE_VERSION}',
                            'LATEST="latest"',
                            'echo "Pack web modules into docker and push to ECR"',
                            'echo "ECR login now"',
                            '$(aws ecr get-login --no-include-email)',
                            'pwd',
                            'echo "build orders-web docker image"',
                            'cd orders-web',
                            'mvn package -Dmaven.test.skip=true',
                            `docker build -f src/main/docker/Dockerfile.jvm -t ${this.ecrRepository.repositoryUri}:$LATEST .`,
                            `docker images`,
                            `docker tag ${this.ecrRepository.repositoryUri}:$LATEST ${this.ecrRepository.repositoryUri}:$TAG`,
                            'echo "Pushing Orders-web"',
                            `docker images`,
                            `docker push ${this.ecrRepository.repositoryUri}:$TAG`,
                            `docker push ${this.ecrRepository.repositoryUri}:$LATEST`,
                            'echo "finished ECR push"',
                            'echo package coffee serverless lambda function',
                            'cd ../coffee-sls',
                            'sam package --template-file template.yaml --s3-bucket ' + bucketName + ' --output-template-file packaged.yaml',
                            'sam deploy --template-file ./packaged.yaml --stack-name coffee-sls --capabilities CAPABILITY_IAM',
                        ]
                    }
                },
            })
        });
        // const vpc = Vpc.fromLookup(this, 'CoffeeShopCdkStack/CoffeeShopVPC',{
        //     vpcName: 'CoffeeShopCdkStack/CoffeeShopVPC',
        //     isDefault: false,
        // });
        const cluster = new ecs.Cluster(this, 'Cluster', {
            clusterName: 'coffeeshop',
            vpc
        });
        const taskDefinition = new ecs.TaskDefinition(this, 'orders-web-Task', {
            compatibility: ecs.Compatibility.FARGATE,
            memoryMiB: '512',
            cpu: '256',
        });
        const containerDefinition = taskDefinition.addContainer('defaultContainer', {
            image: ecs.ContainerImage.fromRegistry('amazon/amazon-ecs-sample'),
            logging: new ecs.AwsLogDriver({
                streamPrefix: 'coffeeshop',
            })
        });
        containerDefinition.addUlimits({
            name: aws_ecs_1.UlimitName.NOFILE,
            softLimit: 102400,
            hardLimit: 819200
        });
        containerDefinition.addPortMappings({
            containerPort: 8080
        });
        const fargatesvc = new ecsPatterns.ApplicationLoadBalancedFargateService(this, 'AlbSvc', {
            cluster,
            taskDefinition,
        });
        const fargateTaskRole = fargatesvc.service.taskDefinition.taskRole;
        fargateTaskRole.addToPolicy(new iam.PolicyStatement({
            resources: ['*'],
            actions: ['events:*']
        }));
        const orderTable = new dynamodb.Table(this, 'Order', {
            partitionKey: { name: 'seqNo', type: dynamodb.AttributeType.NUMBER },
            billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
            tableName: 'Order',
        });
        orderTable.grantFullAccess(fargateTaskRole);
        const coffeeTable = new dynamodb.Table(this, 'Coffee', {
            partitionKey: { name: 'seqNo', type: dynamodb.AttributeType.NUMBER },
            billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
            tableName: 'Coffee',
        });
        coffeeTable.grantFullAccess(fargateTaskRole);
        const rule = new aws_events_1.Rule(this, 'OrderCreatedRule', {
            eventPattern: {
                source: ["solid.humank.coffeeshop.order"],
                detailType: ['customevent']
            },
            // eventBus: coffeeshop_eventbus,
            ruleName: 'OrderCreatedRule',
        });
        //add ssm parameter store for cloudwatchevent put usage
        const eventSourceParam = new ssm.StringParameter(this, 'eventSourceParam', {
            parameterName: '/coffeeshop/events/ordercreated/event_source',
            stringValue: 'solid.humank.coffeeshop.order',
        });
        // Grant read access to some Role
        eventSourceParam.grantRead(fargateTaskRole);
        //add ssm parameter store for cloudwatchevent put usage
        const eventArnParam = new ssm.StringParameter(this, 'eventArnParam', {
            parameterName: '/coffeeshop/events/ordercreated/event_arn',
            stringValue: rule.ruleArn,
        });
        // Grant read access to some Role
        eventArnParam.grantRead(fargateTaskRole);
        // if the default image is not from ECR, the ECS task execution role will not have ECR pull privileges
        // we need grant the pull for it explicitly
        this.ecrRepository.grantPull({
            grantPrincipal: fargatesvc.service.taskDefinition.executionRole
        });
        // reduce the default deregistration delay timeout from 300 to 30 to accelerate the rolling update
        fargatesvc.targetGroup.setAttribute('deregistration_delay.timeout_seconds', '30');
        // customize the healthcheck to speed up the ecs rolling update
        fargatesvc.targetGroup.configureHealthCheck({
            interval: core_1.Duration.seconds(5),
            healthyHttpCodes: '200',
            healthyThresholdCount: 2,
            unhealthyThresholdCount: 3,
            timeout: core_1.Duration.seconds(4),
        });
        // CodePipeline
        const codePipeline = new codepipeline.Pipeline(this, 'CoffeeShopPipeline', {
            pipelineName: 'CoffeeShopPipeline',
        });
        const sourceOutputEcr = new codepipeline.Artifact();
        const sourceOutputCodeCommit = new codepipeline.Artifact();
        const sourceActionECR = new codepipeline_actions.EcrSourceAction({
            actionName: 'ECR',
            repository: this.ecrRepository,
            imageTag: 'latest',
            output: sourceOutputEcr,
        });
        const codecommitRepo = new codecommit.Repository(this, 'GitRepo', {
            repositoryName: CODECOMMIT_REPO_NAME
        });
        const sourceActionCodeCommit = new codepipeline_actions.CodeCommitSourceAction({
            actionName: 'CodeCommit',
            // repository: codecommit.Repository.fromRepositoryName(this, 'GitRepo', CODECOMMIT_REPO_NAME),
            repository: codecommitRepo,
            output: sourceOutputCodeCommit,
        });
        codePipeline.addStage({
            stageName: 'Source',
            actions: [sourceActionCodeCommit, sourceActionECR],
        });
        codePipeline.addStage({
            stageName: 'Deploy',
            actions: [
                new codepipeline_actions.EcsDeployAction({
                    actionName: 'DeployAction',
                    service: fargatesvc.service,
                    // if your file is called imagedefinitions.json,
                    // use the `input` property,
                    // and leave out the `imageFile` property
                    input: sourceOutputCodeCommit,
                }),
            ],
        });
        new cdk.CfnOutput(this, 'ServiceURL', {
            value: `http://${fargatesvc.loadBalancer.loadBalancerDnsName}`
        });
        new cdk.CfnOutput(this, 'StackId', {
            value: this.stackId
        });
        new cdk.CfnOutput(this, 'StackName', {
            value: this.stackName
        });
        new cdk.CfnOutput(this, 'CodeCommitRepoName', {
            value: codecommitRepo.repositoryName
        });
        let codeCommitHint = `
Create a "imagedefinitions.json" file and git add/push into CodeCommit repository "${CODECOMMIT_REPO_NAME}" with the following value:

[
  {
    "name": "defaultContainer",
    "imageUri": "${this.ecrRepository.repositoryUri}:latest"
  }
]
`;
        new cdk.CfnOutput(this, 'Hint', {
            value: codeCommitHint
        });
        new cdk.CfnOutput(this, 'CodeBuildProjectName', {
            value: aws_events_targets_1.CodeBuildProject.name
        });
        new cdk.CfnOutput(this, 'Bucket', { value: coffeeShopBucket.bucketName });
    }
}
exports.CoffeeShopCodePipeline = CoffeeShopCodePipeline;
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiY29mZmVlLXNob3AtY29kZS1waXBlbGluZS5qcyIsInNvdXJjZVJvb3QiOiIiLCJzb3VyY2VzIjpbImNvZmZlZS1zaG9wLWNvZGUtcGlwZWxpbmUudHMiXSwibmFtZXMiOltdLCJtYXBwaW5ncyI6Ijs7O0FBQUEscUNBQXFDO0FBQ3JDLHdDQUF3QztBQUN4Qyx3Q0FBd0M7QUFDeEMsc0NBQXNDO0FBQ3RDLHdDQUF5QztBQUN6QyxvREFBcUQ7QUFDckQsMERBQTBEO0FBQzFELDBFQUEwRTtBQUMxRSx3Q0FBd0M7QUFDeEMseURBQXlEO0FBQ3pELHNEQUFzRDtBQUN0RCxvRUFBNkQ7QUFDN0Qsd0NBQXVDO0FBQ3ZDLGtEQUFrRDtBQUNsRCxvREFBeUM7QUFDekMsd0NBQXdDO0FBQ3hDLDhDQUE4QztBQUU5QyxNQUFNLG1CQUFtQixHQUFHLG9DQUFvQyxDQUFBO0FBQ2hFLE1BQU0sb0JBQW9CLEdBQUcsdUJBQXVCLENBQUE7QUFFcEQsTUFBYSxzQkFBdUIsU0FBUSxHQUFHLENBQUMsS0FBSztJQUdqRCxhQUFhO0lBQ2IsWUFBWSxLQUFjLEVBQUUsRUFBVSxFQUFFLEtBQXNCO1FBQzFELEtBQUssQ0FBQyxLQUFLLEVBQUUsRUFBRSxFQUFFLEtBQUssQ0FBQyxDQUFDO1FBRXhCLGVBQWU7UUFDZixNQUFNLEdBQUcsR0FBRyxJQUFJLEdBQUcsQ0FBQyxHQUFHLENBQUMsSUFBSSxFQUFFLGVBQWUsRUFBRTtZQUMzQyxJQUFJLEVBQUUsYUFBYTtZQUNuQixXQUFXLEVBQUUsQ0FBQztTQUNqQixDQUFDLENBQUM7UUFFSCxJQUFJLENBQUMsYUFBYSxHQUFHLElBQUksR0FBRyxDQUFDLFVBQVUsQ0FBQyxJQUFJLEVBQUUsWUFBWSxFQUFFO1lBQ3hELGNBQWMsRUFBRSxtQkFBbUI7WUFDbkMsYUFBYSxFQUFFLEdBQUcsQ0FBQyxhQUFhLENBQUMsT0FBTztTQUMzQyxDQUFDLENBQUM7UUFDSCxNQUFNLFNBQVMsR0FBRyxJQUFJLEdBQUcsQ0FBQyxJQUFJLENBQUMsSUFBSSxFQUFF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QUMsQ0FBQTtRQUVGLElBQUksR0FBRyxDQUFDLFNBQVMsQ0FBQyxJQUFJLEVBQUUsU0FBUyxFQUFFO1lBQy9CLEtBQUssRUFBRSxJQUFJLENBQUMsT0FBTztTQUN0QixDQUFDLENBQUE7UUFFRixJQUFJLEdBQUcsQ0FBQyxTQUFTLENBQUMsSUFBSSxFQUFFLFdBQVcsRUFBRTtZQUNqQyxLQUFLLEVBQUUsSUFBSSxDQUFDLFNBQVM7U0FDeEIsQ0FBQyxDQUFBO1FBRUYsSUFBSSxHQUFHLENBQUMsU0FBUyxDQUFDLElBQUksRUFBRSxvQkFBb0IsRUFBRTtZQUMxQyxLQUFLLEVBQUUsY0FBYyxDQUFDLGNBQWM7U0FDdkMsQ0FBQyxDQUFBO1FBRUYsSUFBSSxjQUFjLEdBQUc7cUZBQ3dELG9CQUFvQjs7Ozs7bUJBS3RGLElBQUksQ0FBQyxhQUFhLENBQUMsYUFBYTs7O0NBR2xELENBQUE7UUFDTyxJQUFJLEdBQUcsQ0FBQyxTQUFTLENBQUMsSUFBSSxFQUFFLE1BQU0sRUFBRTtZQUM1QixLQUFLLEVBQUUsY0FBYztTQUN4QixDQUFDLENBQUE7UUFFRixJQUFJLEdBQUcsQ0FBQyxTQUFTLENBQUMsSUFBSSxFQUFFLHNCQUFzQixFQUFFO1lBQzVDLEtBQUssRUFBRSxxQ0FBZ0IsQ0FBQyxJQUFJO1NBQy9CLENBQUMsQ0FBQTtRQUVGLElBQUksR0FBRyxDQUFDLFNBQVMsQ0FBQyxJQUFJLEVBQUUsUUFBUSxFQUFFLEVBQUUsS0FBSyxFQUFFLGdCQUFnQixDQUFDLFVBQVUsRUFBRSxDQUFDLENBQUM7SUFFOUUsQ0FBQztDQUNKO0FBbFVELHdEQWtVQyIsInNvdXJjZXNDb250ZW50IjpbImltcG9ydCAqIGFzIGNkayBmcm9tICdAYXdzLWNkay9jb3JlJztcbmltcG9ydCAqIGFzIGVjciBmcm9tICdAYXdzLWNkay9hd3MtZWNyJztcbmltcG9ydCAqIGFzIGlhbSBmcm9tICdAYXdzLWNkay9hd3MtaWFtJztcbmltcG9ydCAqIGFzIHMzIGZyb20gJ0Bhd3MtY2RrL2F3cy1zMyc7XG5pbXBvcnQgZWMyID0gcmVxdWlyZSgnQGF3cy1jZGsvYXdzLWVjMicpO1xuaW1wb3J0ICogYXMgY29kZWJ1aWxkICBmcm9tICdAYXdzLWNkay9hd3MtY29kZWJ1aWxkJztcbmltcG9ydCAqIGFzIGNvZGVwaXBlbGluZSBmcm9tICdAYXdzLWNkay9hd3MtY29kZXBpcGVsaW5lJztcbmltcG9ydCAqIGFzIGNvZGVwaXBlbGluZV9hY3Rpb25zIGZyb20gJ0Bhd3MtY2RrL2F3cy1jb2RlcGlwZWxpbmUtYWN0aW9ucyc7XG5pbXBvcnQgKiBhcyBlY3MgZnJvbSAnQGF3cy1jZGsvYXdzLWVjcyc7XG5pbXBvcnQgKiBhcyBlY3NQYXR0ZXJucyBmcm9tICdAYXdzLWNkay9hd3MtZWNzLXBhdHRlcm5zJztcbmltcG9ydCAqIGFzIGNvZGVjb21taXQgZnJvbSAnQGF3cy1jZGsvYXdzLWNvZGVjb21taXQnO1xuaW1wb3J0IHtDb2RlQnVpbGRQcm9qZWN0fSBmcm9tICdAYXdzLWNkay9hd3MtZXZlbnRzLXRhcmdldHMnO1xuaW1wb3J0IHtEdXJhdGlvbn0gZnJvbSAnQGF3cy1jZGsvY29yZSc7XG5pbXBvcnQgKiBhcyBkeW5hbW9kYiBmcm9tICdAYXdzLWNkay9hd3MtZHluYW1vZGInO1xuaW1wb3J0IHtSdWxlfSBmcm9tIFwiQGF3cy1jZGsvYXdzLWV2ZW50c1wiO1xuaW1wb3J0ICogYXMgc3NtIGZyb20gJ0Bhd3MtY2RrL2F3cy1zc20nO1xuaW1wb3J0IHsgVWxpbWl0TmFtZSB9IGZyb20gJ0Bhd3MtY2RrL2F3cy1lY3MnO1xuXG5jb25zdCBET0NLRVJfSU1BR0VfUFJFRklYID0gJ3NvbGlkLWh1bWFuay1jb2ZmZWVzaG9wL29yZGVycy13ZWInXG5jb25zdCBDT0RFQ09NTUlUX1JFUE9fTkFNRSA9ICdFdmVudFN0b3JtaW5nV29ya3Nob3AnXG5cbmV4cG9ydCBjbGFzcyBDb2ZmZWVTaG9wQ29kZVBpcGVsaW5lIGV4dGVuZHMgY2RrLlN0YWNrIHtcblxuICAgIHJlYWRvbmx5IGVjclJlcG9zaXRvcnk6IGVjci5SZXBvc2l0b3J5XG4gICAgLy8gQHRzLWlnbm9yZVxuICAgIGNvbnN0cnVjdG9yKHNjb3BlOiBjZGsuQXBwLCBpZDogc3RyaW5nLCBwcm9wcz86IGNkay5TdGFja1Byb3BzKSB7XG4gICAgICAgIHN1cGVyKHNjb3BlLCBpZCwgcHJvcHMpO1xuXG4gICAgICAgIC8vIENyZWF0ZSBhIFZQQ1xuICAgICAgICBjb25zdCB2cGMgPSBuZXcgZWMyLlZwYyh0aGlzLCAnQ29mZmVlU2hvcFZQQycsIHtcbiAgICAgICAgICAgIGNpZHI6ICcxMC4wLjAuMC8xNicsXG4gICAgICAgICAgICBuYXRHYXRld2F5czogMVxuICAgICAgICB9KTtcblxuICAgICAgICB0aGlzLmVjclJlcG9zaXRvcnkgPSBuZXcgZWNyLlJlcG9zaXRvcnkodGhpcywgJ1JlcG9zaXRvcnknLCB7XG4gICAgICAgICAgICByZXBvc2l0b3J5TmFtZTogRE9DS0VSX0lNQUdFX1BSRUZJWCxcbiAgICAgICAgICAgIHJlbW92YWxQb2xpY3k6IGNkay5SZW1vdmFsUG9saWN5LkRFU1RST1lcbiAgICAgICAgfSk7XG4gICAgICAgIGNvbnN0IGJ1aWxkUm9sZSA9IG5ldyBpYW0uUm9sZSh0aGlzLCAnQ29kZUJ1aWxkSWFtUm9sZScsIHtcbiAgICAgICAgICAgIGFzc3VtZWRCeTogbmV3IGlhbS5TZXJ2aWNlUHJpbmNpcGFsKCdjb2RlYnVpbGQuYW1hem9uYXdzLmNvbScpXG4gICAgICAgIH0pO1xuICAgICAgICBidWlsZFJvbGUuYWRkTWFuYWdlZFBvbGljeShpYW0uTWFuYWdlZFBvbGljeS5mcm9tQXdzTWFuYWdlZFBvbGljeU5hbWUoXCJBV1NMYW1iZGFGdWxsQWNjZXNzXCIpKTtcbiAgICAgICAgYnVpbGRSb2xlLmFkZE1hbmFnZWRQb2xpY3koaWFtLk1hbmFnZWRQb2xpY3kuZnJvbUF3c01hbmFnZWRQb2xpY3lOYW1lKFwiQW1hem9uQVBJR2F0ZXdheUFkbWluaXN0cmF0b3JcIikpO1xuXG4gICAgICAgIGJ1aWxkUm9sZS5hZGRUb1BvbGljeShuZXcgaWFtLlBvbGljeVN0YXRlbWVudCh7XG4gICAgICAgICAgICByZXNvdXJjZXM6IFsnKiddLFxuICAgICAgICAgICAgYWN0aW9uczogWydjbG91ZGZvcm1hdGlvbjoqJ11cbiAgICAgICAgfSkpO1xuXG4gICAgICAgIGJ1aWxkUm9sZS5hZGRUb1BvbGljeShuZXcgaWFtLlBvbGljeVN0YXRlbWVudCh7XG4gICAgICAgICAgICByZXNvdXJjZXM6IFsnKiddLFxuICAgICAgICAgICAgYWN0aW9uczogWydpYW06KiddXG4gICAgICAgIH0pKTtcblxuICAgICAgICBidWlsZFJvbGUuYWRkVG9Qb2xpY3kobmV3IGlhbS5Qb2xpY3lTdGF0ZW1lbnQoe1xuICAgICAgICAgICAgcmVzb3VyY2VzOiBbJyonXSxcbiAgICAgICAgICAgIGFjdGlvbnM6IFsnZWNyOkdldEF1dGhvcml6YXRpb25Ub2tlbiddXG4gICAgICAgIH0pKTtcblxuICAgICAgICBidWlsZFJvbGUuYWRkVG9Qb2xpY3kobmV3IGlhbS5Qb2xpY3lTdGF0ZW1lbnQoe1xuICAgICAgICAgICAgcmVzb3VyY2VzOiBbYCR7dGhpcy5lY3JSZXBvc2l0b3J5LnJlcG9zaXRvcnlBcm59KmBdLFxuICAgICAgICAgICAgYWN0aW9uczogWydlY3I6KiddXG4gICAgICAgIH0pKTtcblxuICAgICAgICAvLyBFQ1IgTGlmZUN5Y2xlc1xuICAgICAgICAvLyByZXBvc2l0b3J5LmFkZExpZmVjeWNsZVJ1bGUoeyB0YWdQcmVmaXhMaXN0OiBbJ3Byb2QnXSwgbWF4SW1hZ2VDb3VudDogOTk5OSB9KTtcbiAgICAgICAgdGhpcy5lY3JSZXBvc2l0b3J5LmFkZExpZmVjeWNsZVJ1bGUoe21heEltYWdlQWdlOiBjZGsuRHVyYXRpb24uZGF5cygzMCl9KTtcblxuICAgICAgICBjb25zdCBkZWZhdWx0U291cmNlID0gY29kZWJ1aWxkLlNvdXJjZS5naXRIdWIoe1xuICAgICAgICAgICAgb3duZXI6ICdodW1hbmsnLFxuICAgICAgICAgICAgcmVwbzogJ0V2ZW50U3Rvcm1pbmdXb3JrU2hvcCcsXG4gICAgICAgICAgICB3ZWJob29rOiB0cnVlLCAvLyBvcHRpb25hbCwgZGVmYXVsdDogdHJ1ZSBpZiBgd2ViaG9va0ZpbHRlcmVzYCB3ZXJlIHByb3ZpZGVkLCBmYWxzZSBvdGhlcndpc2VcbiAgICAgICAgICAgIHdlYmhvb2tGaWx0ZXJzOiBbXG4gICAgICAgICAgICAgICAgY29kZWJ1aWxkLkZpbHRlckdyb3VwLmluRXZlbnRPZihjb2RlYnVpbGQuRXZlbnRBY3Rpb24uUFVTSCkuYW5kQnJhbmNoSXMoJ21hc3RlcicpLFxuICAgICAgICAgICAgXSwgLy8gb3B0aW9uYWwsIGJ5IGRlZmF1bHQgYWxsIHB1c2hlcyBhbmQgUHVsbCBSZXF1ZXN0cyB3aWxsIHRyaWdnZXIgYSBidWlsZFxuICAgICAgICB9KTtcblxuICAgICAgICBsZXQgYnVja2V0TmFtZSA9ICdjb2ZmZWVzaG9wLScgKyBNYXRoLnJhbmRvbSgpLnRvU3RyaW5nKDM2KS5zdWJzdHJpbmcoNyk7XG4gICAgICAgIGNvbnN0IGNvZmZlZVNob3BCdWNrZXQgPSBuZXcgczMuQnVja2V0KHRoaXMsICdDb2ZmZWVTaG9wQnVja2V0Jywge1xuICAgICAgICAgICAgYnVja2V0TmFtZTogYnVja2V0TmFtZSxcbiAgICAgICAgICAgIC8vIFRoZSBkZWZhdWx0IHJlbW92YWwgcG9saWN5IGlzIFJFVEFJTiwgd2hpY2ggbWVhbnMgdGhhdCBjZGsgZGVzdHJveSB3aWxsIG5vdCBhdHRlbXB0IHRvIGRlbGV0ZVxuICAgICAgICAgICAgLy8gdGhlIG5ldyBidWNrZXQsIGFuZCBpdCB3aWxsIHJlbWFpbiBpbiB5b3VyIGFjY291bnQgdW50aWwgbWFudWFsbHkgZGVsZXRlZC4gQnkgc2V0dGluZyB0aGUgcG9saWN5IHRvXG4gICAgICAgICAgICAvLyBERVNUUk9ZLCBjZGsgZGVzdHJveSB3aWxsIGF0dGVtcHQgdG8gZGVsZXRlIHRoZSBidWNrZXQsIGJ1dCB3aWxsIGVycm9yIGlmIHRoZSBidWNrZXQgaXMgbm90IGVtcHR5LlxuXG4gICAgICAgICAgICAvL3JlbW92YWxQb2xpY3k6IGNkay5SZW1vdmFsUG9saWN5LkRFU1RST1ksIC8vIE5PVCByZWNvbW1lbmRlZCBmb3IgcHJvZHVjdGlvbiBjb2RlXG4gICAgICAgIH0pO1xuXG4gICAgICAgIGNvZmZlZVNob3BCdWNrZXQuZ3JhbnRQdXQoYnVpbGRSb2xlKTtcbiAgICAgICAgY29mZmVlU2hvcEJ1Y2tldC5ncmFudFJlYWQoYnVpbGRSb2xlKTtcbiAgICAgICAgY29mZmVlU2hvcEJ1Y2tldC5ncmFudFJlYWRXcml0ZShidWlsZFJvbGUpO1xuICAgICAgICBjb2ZmZWVTaG9wQnVja2V0LmdyYW50V3JpdGUoYnVpbGRSb2xlKTtcblxuICAgICAgICBuZXcgY29kZWJ1aWxkLlByb2plY3QodGhpcywgJ0NvZGVCdWlsZFByb2plY3QnLCB7XG4gICAgICAgICAgICByb2xlOiBidWlsZFJvbGUsXG4gICAgICAgICAgICBzb3VyY2U6IGRlZmF1bHRTb3VyY2UsXG4gICAgICAgICAgICAvLyBFbmFibGUgRG9ja2VyIEFORCBjdXN0b20gY2FjaGluZ1xuICAgICAgICAgICAgY2FjaGU6IGNvZGVidWlsZC5DYWNoZS5sb2NhbChjb2RlYnVpbGQuTG9jYWxDYWNoZU1vZGUuRE9DS0VSX0xBWUVSLCBjb2RlYnVpbGQuTG9jYWxDYWNoZU1vZGUuQ1VTVE9NKSxcbiAgICAgICAgICAgIGVudmlyb25tZW50OiB7XG4gICAgICAgICAgICAgICAgYnVpbGRJbWFnZTogY29kZWJ1aWxkLkxpbnV4QnVpbGRJbWFnZS5BTUFaT05fTElOVVhfMixcbiAgICAgICAgICAgICAgICBwcml2aWxlZ2VkOiB0cnVlLFxuICAgICAgICAgICAgfSxcbiAgICAgICAgICAgIGJ1aWxkU3BlYzogY29kZWJ1aWxkLkJ1aWxkU3BlYy5mcm9tT2JqZWN0KHtcbiAgICAgICAgICAgICAgICB2ZXJzaW9uOiAnMC4yJyxcbiAgICAgICAgICAgICAgICBwaGFzZXM6IHtcbiAgICAgICAgICAgICAgICAgICAgaW5zdGFsbDp7XG4gICAgICAgICAgICAgICAgICAgICAgICAncnVudGltZS12ZXJzaW9ucyc6IHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBqYXZhOiAnY29ycmV0dG8xMSdcbiAgICAgICAgICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICAgICAgfSxcbiAgICAgICAgICAgICAgICAgICAgYnVpbGQ6IHtcbiAgICAgICAgICAgICAgICAgICAgICAgIGNvbW1hbmRzOiBbXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgJ2VjaG8gXCJCdWlsZCBhbGwgbW9kdWxlc1wiJyxcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAnZWNobyBcIlJ1biBNYXZlbiBjbGVhbiBpbnN0YWxsIHRvIGhhdmUgYWxsIHRoZSByZXF1aXJlZCBqYXJzIGluIGxvY2FsIC5tMiByZXBvc2l0b3J5XCInLFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICdjZCBzb3VyY2VzL2NvZmZlZXNob3AnLFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICdtdm4gY2xlYW4gaW5zdGFsbCAtRG1hdmVuLnRlc3Quc2tpcD10cnVlJ1xuICAgICAgICAgICAgICAgICAgICAgICAgXVxuICAgICAgICAgICAgICAgICAgICB9LFxuICAgICAgICAgICAgICAgICAgICBwb3N0X2J1aWxkOiB7XG4gICAgICAgICAgICAgICAgICAgICAgICBjb21tYW5kczogW1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICdUQUc9JHtDT0RFQlVJTERfUkVTT0xWRURfU09VUkNFX1ZFUlNJT059JyxcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAnTEFURVNUPVwibGF0ZXN0XCInLFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICdlY2hvIFwiUGFjayB3ZWIgbW9kdWxlcyBpbnRvIGRvY2tlciBhbmQgcHVzaCB0byBFQ1JcIicsXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgJ2VjaG8gXCJFQ1IgbG9naW4gbm93XCInLFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICckKGF3cyBlY3IgZ2V0LWxvZ2luIC0tbm8taW5jbHVkZS1lbWFpbCknLFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICdwd2QnLFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICdlY2hvIFwiYnVpbGQgb3JkZXJzLXdlYiBkb2NrZXIgaW1hZ2VcIicsXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgJ2NkIG9yZGVycy13ZWInLFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICdtdm4gcGFja2FnZSAtRG1hdmVuLnRlc3Quc2tpcD10cnVlJyxcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBgZG9ja2VyIGJ1aWxkIC1mIHNyYy9tYWluL2RvY2tlci9Eb2NrZXJmaWxlLmp2bSAtdCAke3RoaXMuZWNyUmVwb3NpdG9yeS5yZXBvc2l0b3J5VXJpfTokTEFURVNUIC5gLFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGBkb2NrZXIgaW1hZ2VzYCxcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBgZG9ja2VyIHRhZyAke3RoaXMuZWNyUmVwb3NpdG9yeS5yZXBvc2l0b3J5VXJpfTokTEFURVNUICR7dGhpcy5lY3JSZXBvc2l0b3J5LnJlcG9zaXRvcnlVcml9OiRUQUdgLFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICdlY2hvIFwiUHVzaGluZyBPcmRlcnMtd2ViXCInLFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGBkb2NrZXIgaW1hZ2VzYCxcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBgZG9ja2VyIHB1c2ggJHt0aGlzLmVjclJlcG9zaXRvcnkucmVwb3NpdG9yeVVyaX06JFRBR2AsXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgYGRvY2tlciBwdXNoICR7dGhpcy5lY3JSZXBvc2l0b3J5LnJlcG9zaXRvcnlVcml9OiRMQVRFU1RgLFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICdlY2hvIFwiZmluaXNoZWQgRUNSIHB1c2hcIicsXG5cbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAnZWNobyBwYWNrYWdlIGNvZmZlZSBzZXJ2ZXJsZXNzIGxhbWJkYSBmdW5jdGlvbicsXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgJ2NkIC4uL2NvZmZlZS1zbHMnLFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICdzYW0gcGFja2FnZSAtLXRlbXBsYXRlLWZpbGUgdGVtcGxhdGUueWFtbCAtLXMzLWJ1Y2tldCAnKyBidWNrZXROYW1lICsgJyAtLW91dHB1dC10ZW1wbGF0ZS1maWxlIHBhY2thZ2VkLnlhbWwnLFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICdzYW0gZGVwbG95IC0tdGVtcGxhdGUtZmlsZSAuL3BhY2thZ2VkLnlhbWwgLS1zdGFjay1uYW1lIGNvZmZlZS1zbHMgLS1jYXBhYmlsaXRpZXMgQ0FQQUJJTElUWV9JQU0nLFxuICAgICAgICAgICAgICAgICAgICAgICAgXVxuXG4gICAgICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICB9LFxuICAgICAgICAgICAgICAgIC8vIGNhY2hlOntcbiAgICAgICAgICAgICAgICAvLyAgICAgcGF0aHM6W1xuICAgICAgICAgICAgICAgIC8vICAgICAgICAgJy9yb290Ly5tMi8qKi8qJyxcbiAgICAgICAgICAgICAgICAvLyAgICAgXVxuICAgICAgICAgICAgICAgIC8vIH1cbiAgICAgICAgICAgIH0pXG4gICAgICAgIH0pO1xuXG4gICAgICAgIC8vIGNvbnN0IHZwYyA9IFZwYy5mcm9tTG9va3VwKHRoaXMsICdDb2ZmZWVTaG9wQ2RrU3RhY2svQ29mZmVlU2hvcFZQQycse1xuICAgICAgICAvLyAgICAgdnBjTmFtZTogJ0NvZmZlZVNob3BDZGtTdGFjay9Db2ZmZWVTaG9wVlBDJyxcbiAgICAgICAgLy8gICAgIGlzRGVmYXVsdDogZmFsc2UsXG4gICAgICAgIC8vIH0pO1xuXG4gICAgICAgIGNvbnN0IGNsdXN0ZXIgPSBuZXcgZWNzLkNsdXN0ZXIodGhpcywgJ0NsdXN0ZXInLCB7XG4gICAgICAgICAgICBjbHVzdGVyTmFtZTogJ2NvZmZlZXNob3AnLFxuICAgICAgICAgICAgdnBjXG4gICAgICAgIH0pO1xuXG5cblxuICAgICAgICBjb25zdCB0YXNrRGVmaW5pdGlvbiA9IG5ldyBlY3MuVGFza0RlZmluaXRpb24odGhpcywgJ29yZGVycy13ZWItVGFzaycsIHtcbiAgICAgICAgICAgIGNvbXBhdGliaWxpdHk6IGVjcy5Db21wYXRpYmlsaXR5LkZBUkdBVEUsXG4gICAgICAgICAgICBtZW1vcnlNaUI6ICc1MTInLFxuICAgICAgICAgICAgY3B1OiAnMjU2JyxcbiAgICAgICAgICAgIFxuICAgICAgICB9KTtcblxuICAgICAgICBjb25zdCBjb250YWluZXJEZWZpbml0aW9uID0gdGFza0RlZmluaXRpb24uYWRkQ29udGFpbmVyKCdkZWZhdWx0Q29udGFpbmVyJywge1xuICAgICAgICAgICAgaW1hZ2U6IGVjcy5Db250YWluZXJJbWFnZS5mcm9tUmVnaXN0cnkoJ2FtYXpvbi9hbWF6b24tZWNzLXNhbXBsZScpLFxuICAgICAgICAgICAgbG9nZ2luZzogbmV3IGVjcy5Bd3NMb2dEcml2ZXIoe1xuICAgICAgICAgICAgICAgIHN0cmVhbVByZWZpeDogJ2NvZmZlZXNob3AnLFxuICAgICAgICAgICAgfSlcbiAgICAgICAgfSk7XG5cbiAgICAgICAgY29udGFpbmVyRGVmaW5pdGlvbi5hZGRVbGltaXRzKHtcbiAgICAgICAgICAgIG5hbWU6IFVsaW1pdE5hbWUuTk9GSUxFLFxuICAgICAgICAgICAgc29mdExpbWl0OjEwMjQwMCAsXG4gICAgICAgICAgICBoYXJkTGltaXQ6IDgxOTIwMFxuICAgICAgICB9KTtcblxuICAgICAgICBjb250YWluZXJEZWZpbml0aW9uLmFkZFBvcnRNYXBwaW5ncyh7XG4gICAgICAgICAgICBjb250YWluZXJQb3J0OiA4MDgwXG4gICAgICAgIH0pO1xuXG4gICAgICAgIGNvbnN0IGZhcmdhdGVzdmMgPSBuZXcgZWNzUGF0dGVybnMuQXBwbGljYXRpb25Mb2FkQmFsYW5jZWRGYXJnYXRlU2VydmljZSh0aGlzLCAnQWxiU3ZjJywge1xuICAgICAgICAgICAgY2x1c3RlcixcbiAgICAgICAgICAgIHRhc2tEZWZpbml0aW9uLFxuICAgICAgICB9KVxuXG4gICAgICAgIGNvbnN0IGZhcmdhdGVUYXNrUm9sZSA9IGZhcmdhdGVzdmMuc2VydmljZS50YXNrRGVmaW5pdGlvbi50YXNrUm9sZTtcbiAgICAgICAgZmFyZ2F0ZVRhc2tSb2xlLmFkZFRvUG9saWN5KG5ldyBpYW0uUG9saWN5U3RhdGVtZW50KHtcbiAgICAgICAgICAgIHJlc291cmNlczogWycqJ10sXG4gICAgICAgICAgICBhY3Rpb25zOiBbJ2V2ZW50czoqJ11cbiAgICAgICAgfSkpO1xuICAgICAgICBjb25zdCBvcmRlclRhYmxlID0gbmV3IGR5bmFtb2RiLlRhYmxlKHRoaXMsICdPcmRlcicsIHtcbiAgICAgICAgICAgIHBhcnRpdGlvbktleTogeyBuYW1lOiAnc2VxTm8nLCB0eXBlOiBkeW5hbW9kYi5BdHRyaWJ1dGVUeXBlLk5VTUJFUiB9LFxuICAgICAgICAgICAgYmlsbGluZ01vZGU6IGR5bmFtb2RiLkJpbGxpbmdNb2RlLlBBWV9QRVJfUkVRVUVTVCxcbiAgICAgICAgICAgIHRhYmxlTmFtZTogJ09yZGVyJyxcbiAgICAgICAgfSk7XG5cbiAgICAgICAgb3JkZXJUYWJsZS5ncmFudEZ1bGxBY2Nlc3MoZmFyZ2F0ZVRhc2tSb2xlKTtcblxuICAgICAgICBjb25zdCBjb2ZmZWVUYWJsZSA9IG5ldyBkeW5hbW9kYi5UYWJsZSh0aGlzLCAnQ29mZmVlJywge1xuICAgICAgICAgICAgcGFydGl0aW9uS2V5OiB7IG5hbWU6ICdzZXFObycsIHR5cGU6IGR5bmFtb2RiLkF0dHJpYnV0ZVR5cGUuTlVNQkVSIH0sXG4gICAgICAgICAgICBiaWxsaW5nTW9kZTogZHluYW1vZGIuQmlsbGluZ01vZGUuUEFZX1BFUl9SRVFVRVNULFxuICAgICAgICAgICAgdGFibGVOYW1lOiAnQ29mZmVlJyxcbiAgICAgICAgfSk7XG5cbiAgICAgICAgY29mZmVlVGFibGUuZ3JhbnRGdWxsQWNjZXNzKGZhcmdhdGVUYXNrUm9sZSk7XG5cbiAgICAgICAgY29uc3QgcnVsZSA9IG5ldyBSdWxlKHRoaXMsICdPcmRlckNyZWF0ZWRSdWxlJyx7XG4gICAgICAgICAgICBldmVudFBhdHRlcm46e1xuICAgICAgICAgICAgICAgIHNvdXJjZTpbXCJzb2xpZC5odW1hbmsuY29mZmVlc2hvcC5vcmRlclwiXSxcbiAgICAgICAgICAgICAgICBkZXRhaWxUeXBlOlsnY3VzdG9tZXZlbnQnXVxuICAgICAgICAgICAgfSxcbiAgICAgICAgICAgIC8vIGV2ZW50QnVzOiBjb2ZmZWVzaG9wX2V2ZW50YnVzLFxuICAgICAgICAgICAgcnVsZU5hbWU6ICdPcmRlckNyZWF0ZWRSdWxlJyxcbiAgICAgICAgfSk7XG5cbiAgICAgICAgLy9hZGQgc3NtIHBhcmFtZXRlciBzdG9yZSBmb3IgY2xvdWR3YXRjaGV2ZW50IHB1dCB1c2FnZVxuICAgICAgICBjb25zdCBldmVudFNvdXJjZVBhcmFtID0gbmV3IHNzbS5TdHJpbmdQYXJhbWV0ZXIodGhpcywgJ2V2ZW50U291cmNlUGFyYW0nLCB7XG4gICAgICAgICAgICBwYXJhbWV0ZXJOYW1lOiAnL2NvZmZlZXNob3AvZXZlbnRzL29yZGVyY3JlYXRlZC9ldmVudF9zb3VyY2UnLFxuICAgICAgICAgICAgc3RyaW5nVmFsdWU6ICdzb2xpZC5odW1hbmsuY29mZmVlc2hvcC5vcmRlcicsXG4gICAgICAgIH0pO1xuXG4gICAgICAgIC8vIEdyYW50IHJlYWQgYWNjZXNzIHRvIHNvbWUgUm9sZVxuICAgICAgICBldmVudFNvdXJjZVBhcmFtLmdyYW50UmVhZChmYXJnYXRlVGFza1JvbGUpO1xuXG4gICAgICAgIC8vYWRkIHNzbSBwYXJhbWV0ZXIgc3RvcmUgZm9yIGNsb3Vkd2F0Y2hldmVudCBwdXQgdXNhZ2VcbiAgICAgICAgY29uc3QgZXZlbnRBcm5QYXJhbSA9IG5ldyBzc20uU3RyaW5nUGFyYW1ldGVyKHRoaXMsICdldmVudEFyblBhcmFtJywge1xuICAgICAgICAgICAgcGFyYW1ldGVyTmFtZTogJy9jb2ZmZWVzaG9wL2V2ZW50cy9vcmRlcmNyZWF0ZWQvZXZlbnRfYXJuJyxcbiAgICAgICAgICAgIHN0cmluZ1ZhbHVlOiBydWxlLnJ1bGVBcm4sXG4gICAgICAgIH0pO1xuXG4gICAgICAgIC8vIEdyYW50IHJlYWQgYWNjZXNzIHRvIHNvbWUgUm9sZVxuICAgICAgICBldmVudEFyblBhcmFtLmdyYW50UmVhZChmYXJnYXRlVGFza1JvbGUpO1xuXG4gICAgICAgIC8vIGlmIHRoZSBkZWZhdWx0IGltYWdlIGlzIG5vdCBmcm9tIEVDUiwgdGhlIEVDUyB0YXNrIGV4ZWN1dGlvbiByb2xlIHdpbGwgbm90IGhhdmUgRUNSIHB1bGwgcHJpdmlsZWdlc1xuICAgICAgICAvLyB3ZSBuZWVkIGdyYW50IHRoZSBwdWxsIGZvciBpdCBleHBsaWNpdGx5XG4gICAgICAgIHRoaXMuZWNyUmVwb3NpdG9yeS5ncmFudFB1bGwoe1xuICAgICAgICAgICAgZ3JhbnRQcmluY2lwYWw6IChmYXJnYXRlc3ZjLnNlcnZpY2UudGFza0RlZmluaXRpb24uZXhlY3V0aW9uUm9sZSBhcyBpYW0uSVJvbGUpXG4gICAgICAgIH0pXG5cbiAgICAgICAgLy8gcmVkdWNlIHRoZSBkZWZhdWx0IGRlcmVnaXN0cmF0aW9uIGRlbGF5IHRpbWVvdXQgZnJvbSAzMDAgdG8gMzAgdG8gYWNjZWxlcmF0ZSB0aGUgcm9sbGluZyB1cGRhdGVcbiAgICAgICAgZmFyZ2F0ZXN2Yy50YXJnZXRHcm91cC5zZXRBdHRyaWJ1dGUoJ2RlcmVnaXN0cmF0aW9uX2RlbGF5LnRpbWVvdXRfc2Vjb25kcycsICczMCcpXG4gICAgICAgIC8vIGN1c3RvbWl6ZSB0aGUgaGVhbHRoY2hlY2sgdG8gc3BlZWQgdXAgdGhlIGVjcyByb2xsaW5nIHVwZGF0ZVxuICAgICAgICBmYXJnYXRlc3ZjLnRhcmdldEdyb3VwLmNvbmZpZ3VyZUhlYWx0aENoZWNrKHtcbiAgICAgICAgICAgIGludGVydmFsOiBEdXJhdGlvbi5zZWNvbmRzKDUpLFxuICAgICAgICAgICAgaGVhbHRoeUh0dHBDb2RlczogJzIwMCcsXG4gICAgICAgICAgICBoZWFsdGh5VGhyZXNob2xkQ291bnQ6IDIsXG4gICAgICAgICAgICB1bmhlYWx0aHlUaHJlc2hvbGRDb3VudDogMyxcbiAgICAgICAgICAgIHRpbWVvdXQ6IER1cmF0aW9uLnNlY29uZHMoNCksXG4gICAgICAgIH0pXG5cbiAgICAgICAgLy8gQ29kZVBpcGVsaW5lXG4gICAgICAgIGNvbnN0IGNvZGVQaXBlbGluZSA9IG5ldyBjb2RlcGlwZWxpbmUuUGlwZWxpbmUodGhpcywgJ0NvZmZlZVNob3BQaXBlbGluZScsIHtcbiAgICAgICAgICAgIHBpcGVsaW5lTmFtZTogJ0NvZmZlZVNob3BQaXBlbGluZScsXG4gICAgICAgIH0pO1xuXG4gICAgICAgIGNvbnN0IHNvdXJjZU91dHB1dEVjciA9IG5ldyBjb2RlcGlwZWxpbmUuQXJ0aWZhY3QoKTtcbiAgICAgICAgY29uc3Qgc291cmNlT3V0cHV0Q29kZUNvbW1pdCA9IG5ldyBjb2RlcGlwZWxpbmUuQXJ0aWZhY3QoKTtcbiAgICAgICAgY29uc3Qgc291cmNlQWN0aW9uRUNSID0gbmV3IGNvZGVwaXBlbGluZV9hY3Rpb25zLkVjclNvdXJjZUFjdGlvbih7XG4gICAgICAgICAgICBhY3Rpb25OYW1lOiAnRUNSJyxcbiAgICAgICAgICAgIHJlcG9zaXRvcnk6IHRoaXMuZWNyUmVwb3NpdG9yeSxcbiAgICAgICAgICAgIGltYWdlVGFnOiAnbGF0ZXN0JywgLy8gb3B0aW9uYWwsIGRlZmF1bHQ6ICdsYXRlc3QnXG4gICAgICAgICAgICBvdXRwdXQ6IHNvdXJjZU91dHB1dEVjcixcbiAgICAgICAgfSk7XG5cbiAgICAgICAgY29uc3QgY29kZWNvbW1pdFJlcG8gPSBuZXcgY29kZWNvbW1pdC5SZXBvc2l0b3J5KHRoaXMsICdHaXRSZXBvJywge1xuICAgICAgICAgICAgcmVwb3NpdG9yeU5hbWU6IENPREVDT01NSVRfUkVQT19OQU1FXG4gICAgICAgIH0pO1xuXG4gICAgICAgIGNvbnN0IHNvdXJjZUFjdGlvbkNvZGVDb21taXQgPSBuZXcgY29kZXBpcGVsaW5lX2FjdGlvbnMuQ29kZUNvbW1pdFNvdXJjZUFjdGlvbih7XG4gICAgICAgICAgICBhY3Rpb25OYW1lOiAnQ29kZUNvbW1pdCcsXG4gICAgICAgICAgICAvLyByZXBvc2l0b3J5OiBjb2RlY29tbWl0LlJlcG9zaXRvcnkuZnJvbVJlcG9zaXRvcnlOYW1lKHRoaXMsICdHaXRSZXBvJywgQ09ERUNPTU1JVF9SRVBPX05BTUUpLFxuICAgICAgICAgICAgcmVwb3NpdG9yeTogY29kZWNvbW1pdFJlcG8sXG4gICAgICAgICAgICBvdXRwdXQ6IHNvdXJjZU91dHB1dENvZGVDb21taXQsXG4gICAgICAgIH0pO1xuXG4gICAgICAgIGNvZGVQaXBlbGluZS5hZGRTdGFnZSh7XG4gICAgICAgICAgICBzdGFnZU5hbWU6ICdTb3VyY2UnLFxuICAgICAgICAgICAgYWN0aW9uczogW3NvdXJjZUFjdGlvbkNvZGVDb21taXQsIHNvdXJjZUFjdGlvbkVDUl0sXG4gICAgICAgIH0pO1xuXG4gICAgICAgIGNvZGVQaXBlbGluZS5hZGRTdGFnZSh7XG4gICAgICAgICAgICBzdGFnZU5hbWU6ICdEZXBsb3knLFxuICAgICAgICAgICAgYWN0aW9uczogW1xuICAgICAgICAgICAgICAgIG5ldyBjb2RlcGlwZWxpbmVfYWN0aW9ucy5FY3NEZXBsb3lBY3Rpb24oe1xuICAgICAgICAgICAgICAgICAgICBhY3Rpb25OYW1lOiAnRGVwbG95QWN0aW9uJyxcbiAgICAgICAgICAgICAgICAgICAgc2VydmljZTogZmFyZ2F0ZXN2Yy5zZXJ2aWNlLFxuICAgICAgICAgICAgICAgICAgICAvLyBpZiB5b3VyIGZpbGUgaXMgY2FsbGVkIGltYWdlZGVmaW5pdGlvbnMuanNvbixcbiAgICAgICAgICAgICAgICAgICAgLy8gdXNlIHRoZSBgaW5wdXRgIHByb3BlcnR5LFxuICAgICAgICAgICAgICAgICAgICAvLyBhbmQgbGVhdmUgb3V0IHRoZSBgaW1hZ2VGaWxlYCBwcm9wZXJ0eVxuICAgICAgICAgICAgICAgICAgICBpbnB1dDogc291cmNlT3V0cHV0Q29kZUNvbW1pdCxcbiAgICAgICAgICAgICAgICAgICAgLy8gaWYgeW91ciBmaWxlIG5hbWUgaXMgX25vdF8gaW1hZ2VkZWZpbml0aW9ucy5qc29uLFxuICAgICAgICAgICAgICAgICAgICAvLyB1c2UgdGhlIGBpbWFnZUZpbGVgIHByb3BlcnR5LFxuICAgICAgICAgICAgICAgICAgICAvLyBhbmQgbGVhdmUgb3V0IHRoZSBgaW5wdXRgIHByb3BlcnR5XG4gICAgICAgICAgICAgICAgICAgIC8vIGltYWdlRmlsZTogc291cmNlT3V0cHV0LmF0UGF0aCgnaW1hZ2VEZWYuanNvbicpLFxuICAgICAgICAgICAgICAgIH0pLFxuICAgICAgICAgICAgXSxcbiAgICAgICAgfSk7XG4gICAgICAgIG5ldyBjZGsuQ2ZuT3V0cHV0KHRoaXMsICdTZXJ2aWNlVVJMJywge1xuICAgICAgICAgICAgdmFsdWU6IGBodHRwOi8vJHtmYXJnYXRlc3ZjLmxvYWRCYWxhbmNlci5sb2FkQmFsYW5jZXJEbnNOYW1lfWBcbiAgICAgICAgfSlcblxuICAgICAgICBuZXcgY2RrLkNmbk91dHB1dCh0aGlzLCAnU3RhY2tJZCcsIHtcbiAgICAgICAgICAgIHZhbHVlOiB0aGlzLnN0YWNrSWRcbiAgICAgICAgfSlcblxuICAgICAgICBuZXcgY2RrLkNmbk91dHB1dCh0aGlzLCAnU3RhY2tOYW1lJywge1xuICAgICAgICAgICAgdmFsdWU6IHRoaXMuc3RhY2tOYW1lXG4gICAgICAgIH0pXG5cbiAgICAgICAgbmV3IGNkay5DZm5PdXRwdXQodGhpcywgJ0NvZGVDb21taXRSZXBvTmFtZScsIHtcbiAgICAgICAgICAgIHZhbHVlOiBjb2RlY29tbWl0UmVwby5yZXBvc2l0b3J5TmFtZVxuICAgICAgICB9KVxuXG4gICAgICAgIGxldCBjb2RlQ29tbWl0SGludCA9IGBcbkNyZWF0ZSBhIFwiaW1hZ2VkZWZpbml0aW9ucy5qc29uXCIgZmlsZSBhbmQgZ2l0IGFkZC9wdXNoIGludG8gQ29kZUNvbW1pdCByZXBvc2l0b3J5IFwiJHtDT0RFQ09NTUlUX1JFUE9fTkFNRX1cIiB3aXRoIHRoZSBmb2xsb3dpbmcgdmFsdWU6XG5cbltcbiAge1xuICAgIFwibmFtZVwiOiBcImRlZmF1bHRDb250YWluZXJcIixcbiAgICBcImltYWdlVXJpXCI6IFwiJHt0aGlzLmVjclJlcG9zaXRvcnkucmVwb3NpdG9yeVVyaX06bGF0ZXN0XCJcbiAgfVxuXVxuYFxuICAgICAgICBuZXcgY2RrLkNmbk91dHB1dCh0aGlzLCAnSGludCcsIHtcbiAgICAgICAgICAgIHZhbHVlOiBjb2RlQ29tbWl0SGludFxuICAgICAgICB9KVxuXG4gICAgICAgIG5ldyBjZGsuQ2ZuT3V0cHV0KHRoaXMsICdDb2RlQnVpbGRQcm9qZWN0TmFtZScsIHtcbiAgICAgICAgICAgIHZhbHVlOiBDb2RlQnVpbGRQcm9qZWN0Lm5hbWVcbiAgICAgICAgfSlcblxuICAgICAgICBuZXcgY2RrLkNmbk91dHB1dCh0aGlzLCAnQnVja2V0JywgeyB2YWx1ZTogY29mZmVlU2hvcEJ1Y2tldC5idWNrZXROYW1lIH0pO1xuXG4gICAgfVxufSJdfQ==