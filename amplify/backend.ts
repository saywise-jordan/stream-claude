import { defineBackend } from "@aws-amplify/backend";
import { auth } from "./auth/resource";
import { data } from "./data/resource";
import { chat } from "./functions/chat/resource";
import { chatWs } from "./functions/chat-ws/resource";
import { chatWebsocket } from "./functions/chat-websocket/resource";
import {
  FunctionUrlAuthType,
  HttpMethod,
  InvokeMode,
  Function as LambdaFunction,
} from "aws-cdk-lib/aws-lambda";
import { PolicyStatement, Effect } from "aws-cdk-lib/aws-iam";
import { Stack, Duration, RemovalPolicy } from "aws-cdk-lib";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import * as apigatewayv2 from "aws-cdk-lib/aws-apigatewayv2";
import { WebSocketLambdaIntegration } from "aws-cdk-lib/aws-apigatewayv2-integrations";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import * as ecs from "aws-cdk-lib/aws-ecs";
import * as ecr from "aws-cdk-lib/aws-ecr";
import * as elbv2 from "aws-cdk-lib/aws-elasticloadbalancingv2";
import * as secretsmanager from "aws-cdk-lib/aws-secretsmanager";
import * as logs from "aws-cdk-lib/aws-logs";

const backend = defineBackend({
  auth,
  data,
  chat,
  chatWs,
  chatWebsocket,
});

const chatFunctionLambda = backend.chat.resources.lambda;
const chatFunctionUrl = chatFunctionLambda.addFunctionUrl({
  authType: FunctionUrlAuthType.AWS_IAM,
  invokeMode: InvokeMode.RESPONSE_STREAM,
  cors: {
    allowedOrigins: ["*"],
    allowedMethods: [HttpMethod.ALL],
    allowedHeaders: ["*"],
  },
});

backend.auth.resources.authenticatedUserIamRole.addToPrincipalPolicy(
  new PolicyStatement({
    effect: Effect.ALLOW,
    actions: ["lambda:InvokeFunctionUrl"],
    resources: [chatFunctionLambda.functionArn],
  })
);

const chatWebsocketLambda = backend.chatWebsocket.resources.lambda;
const chatWebsocketLambdaFn = chatWebsocketLambda as LambdaFunction;
const stack = Stack.of(chatWebsocketLambda);

const connectionsTable = new dynamodb.Table(stack, "WebSocketConnections", {
  partitionKey: { name: "connectionId", type: dynamodb.AttributeType.STRING },
  billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
  timeToLiveAttribute: "ttl",
});

connectionsTable.grantReadWriteData(chatWebsocketLambda);
chatWebsocketLambdaFn.addEnvironment(
  "CONNECTIONS_TABLE_NAME",
  connectionsTable.tableName
);

const webSocketApi = new apigatewayv2.WebSocketApi(stack, "ChatWebSocketApi", {
  connectRouteOptions: {
    integration: new WebSocketLambdaIntegration(
      "ConnectIntegration",
      chatWebsocketLambda
    ),
  },
  disconnectRouteOptions: {
    integration: new WebSocketLambdaIntegration(
      "DisconnectIntegration",
      chatWebsocketLambda
    ),
  },
  defaultRouteOptions: {
    integration: new WebSocketLambdaIntegration(
      "DefaultIntegration",
      chatWebsocketLambda
    ),
  },
});

webSocketApi.addRoute("sendMessage", {
  integration: new WebSocketLambdaIntegration(
    "SendMessageIntegration",
    chatWebsocketLambda
  ),
});

const webSocketStage = new apigatewayv2.WebSocketStage(
  stack,
  "ChatWebSocketStage",
  {
    webSocketApi,
    stageName: "prod",
    autoDeploy: true,
  }
);

chatWebsocketLambda.addToRolePolicy(
  new PolicyStatement({
    effect: Effect.ALLOW,
    actions: ["execute-api:ManageConnections"],
    resources: [
      `arn:aws:execute-api:${stack.region}:${stack.account}:${webSocketApi.apiId}/*`,
    ],
  })
);

// ECS Chat Service Infrastructure
const vpc = new ec2.Vpc(stack, "EcsChatVpc", {
  maxAzs: 2,
  natGateways: 1,
  subnetConfiguration: [
    {
      name: "Public",
      subnetType: ec2.SubnetType.PUBLIC,
      cidrMask: 24,
    },
    {
      name: "Private",
      subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS,
      cidrMask: 24,
    },
  ],
});

const cluster = new ecs.Cluster(stack, "EcsChatCluster", {
  vpc,
  containerInsights: true,
});

const ecsChatRepo = ecr.Repository.fromRepositoryName(
  stack,
  "EcsChatRepository",
  "ecs-chat"
);

const anthropicApiKeySecret = new secretsmanager.Secret(
  stack,
  "AnthropicApiKeySecret",
  {
    secretName: "claude-stream/anthropic-api-key",
    description: "Anthropic API key for ECS Chat service",
  }
);

const taskDefinition = new ecs.FargateTaskDefinition(
  stack,
  "EcsChatTaskDefinition",
  {
    memoryLimitMiB: 512,
    cpu: 256,
  }
);

const logGroup = new logs.LogGroup(stack, "EcsChatLogGroup", {
  logGroupName: "/ecs/ecs-chat",
  removalPolicy: RemovalPolicy.DESTROY,
  retention: logs.RetentionDays.ONE_WEEK,
});

const cognitoUserPoolId = backend.auth.resources.userPool.userPoolId;
const cognitoClientId = backend.auth.resources.userPoolClient.userPoolClientId;

taskDefinition.addContainer("EcsChatContainer", {
  image: ecs.ContainerImage.fromEcrRepository(ecsChatRepo, "latest"),
  logging: ecs.LogDrivers.awsLogs({
    streamPrefix: "ecs-chat",
    logGroup,
  }),
  environment: {
    NODE_ENV: "production",
    PORT: "3000",
    COGNITO_USER_POOL_ID: cognitoUserPoolId,
    COGNITO_CLIENT_ID: cognitoClientId,
  },
  secrets: {
    ANTHROPIC_API_KEY: ecs.Secret.fromSecretsManager(anthropicApiKeySecret),
  },
  portMappings: [
    {
      containerPort: 3000,
      protocol: ecs.Protocol.TCP,
    },
  ],
  healthCheck: {
    command: [
      "CMD-SHELL",
      "wget --no-verbose --tries=1 --spider http://localhost:3000/health || exit 1",
    ],
    interval: Duration.seconds(30),
    timeout: Duration.seconds(5),
    retries: 3,
    startPeriod: Duration.seconds(60),
  },
});

const albSecurityGroup = new ec2.SecurityGroup(stack, "AlbSecurityGroup", {
  vpc,
  allowAllOutbound: true,
});
albSecurityGroup.addIngressRule(
  ec2.Peer.anyIpv4(),
  ec2.Port.tcp(80),
  "Allow HTTP"
);
albSecurityGroup.addIngressRule(
  ec2.Peer.anyIpv4(),
  ec2.Port.tcp(443),
  "Allow HTTPS"
);

const serviceSecurityGroup = new ec2.SecurityGroup(
  stack,
  "EcsServiceSecurityGroup",
  {
    vpc,
    allowAllOutbound: true,
  }
);
serviceSecurityGroup.addIngressRule(
  albSecurityGroup,
  ec2.Port.tcp(3000),
  "Allow from ALB"
);

const alb = new elbv2.ApplicationLoadBalancer(stack, "EcsChatAlb", {
  vpc,
  internetFacing: true,
  securityGroup: albSecurityGroup,
});

const fargateService = new ecs.FargateService(stack, "EcsChatService", {
  cluster,
  taskDefinition,
  desiredCount: 1,
  assignPublicIp: false,
  securityGroups: [serviceSecurityGroup],
  vpcSubnets: {
    subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS,
  },
  circuitBreaker: {
    rollback: true,
  },
});

const targetGroup = new elbv2.ApplicationTargetGroup(
  stack,
  "EcsChatTargetGroup",
  {
    vpc,
    port: 3000,
    protocol: elbv2.ApplicationProtocol.HTTP,
    targetType: elbv2.TargetType.IP,
    healthCheck: {
      path: "/health",
      interval: Duration.seconds(30),
      timeout: Duration.seconds(5),
      healthyThresholdCount: 2,
      unhealthyThresholdCount: 3,
    },
    stickinessCookieDuration: Duration.hours(1),
  }
);

fargateService.attachToApplicationTargetGroup(targetGroup);

alb.addListener("HttpListener", {
  port: 80,
  defaultTargetGroups: [targetGroup],
});

const scaling = fargateService.autoScaleTaskCount({
  minCapacity: 1,
  maxCapacity: 4,
});

scaling.scaleOnCpuUtilization("CpuScaling", {
  targetUtilizationPercent: 70,
  scaleInCooldown: Duration.seconds(60),
  scaleOutCooldown: Duration.seconds(60),
});

backend.addOutput({
  custom: {
    chatUrl: chatFunctionUrl.url,
    chatWebSocketUrl: webSocketStage.url,
    ecsChatUrl: `http://${alb.loadBalancerDnsName}`,
    ecsChatWsUrl: `ws://${alb.loadBalancerDnsName}`,
    ecrRepositoryUri: ecsChatRepo.repositoryUri,
  },
});
