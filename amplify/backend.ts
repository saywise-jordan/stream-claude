import { defineBackend } from "@aws-amplify/backend";
import { auth } from "./auth/resource";
import { data } from "./data/resource";
import { chat } from "./functions/chat/resource";
import { chatWs } from "./functions/chat-ws/resource";
import {
  FunctionUrlAuthType,
  HttpMethod,
  InvokeMode,
} from "aws-cdk-lib/aws-lambda";
import { PolicyStatement, Effect } from "aws-cdk-lib/aws-iam";
import { WebSocketApi, WebSocketStage } from "aws-cdk-lib/aws-apigatewayv2";
import { WebSocketLambdaIntegration } from "aws-cdk-lib/aws-apigatewayv2-integrations";
import { AttributeType, Table, BillingMode } from "aws-cdk-lib/aws-dynamodb";
import { RemovalPolicy } from "aws-cdk-lib";

const backend = defineBackend({
  auth,
  data,
  chat,
  chatWs,
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

// WebSocket API setup with Gen 2 CDK constructs
const chatWsLambda = backend.chatWs.resources.lambda;

// Create DynamoDB table for WebSocket connection management
const connectionsTable = new Table(backend.chatWs.stack, "WebSocketConnections", {
  partitionKey: { name: "connectionId", type: AttributeType.STRING },
  billingMode: BillingMode.PAY_PER_REQUEST,
  removalPolicy: RemovalPolicy.DESTROY, // Use RETAIN for production
});

// Create WebSocket API with Lambda integrations
const webSocketApi = new WebSocketApi(backend.chatWs.stack, "ChatWebSocketApi", {
  connectRouteOptions: {
    integration: new WebSocketLambdaIntegration(
      "ConnectIntegration",
      chatWsLambda
    ),
  },
  disconnectRouteOptions: {
    integration: new WebSocketLambdaIntegration(
      "DisconnectIntegration",
      chatWsLambda
    ),
  },
  defaultRouteOptions: {
    integration: new WebSocketLambdaIntegration(
      "DefaultIntegration",
      chatWsLambda
    ),
  },
});

// Create WebSocket stage
const webSocketStage = new WebSocketStage(
  backend.chatWs.stack,
  "ChatWebSocketStage",
  {
    webSocketApi,
    stageName: "prod",
    autoDeploy: true,
  }
);

// Grant DynamoDB permissions to Lambda
connectionsTable.grantReadWriteData(chatWsLambda);

// Add environment variables to Lambda
backend.chatWs.addEnvironment("CONNECTIONS_TABLE_NAME", connectionsTable.tableName);
backend.chatWs.addEnvironment("WEBSOCKET_API_ENDPOINT", webSocketStage.callbackUrl);

// Grant Lambda permission to post to WebSocket connections
chatWsLambda.addToRolePolicy(
  new PolicyStatement({
    effect: Effect.ALLOW,
    actions: ["execute-api:ManageConnections"],
    resources: [
      `arn:aws:execute-api:*:*:${webSocketApi.apiId}/*`,
    ],
  })
);

// Grant authenticated users permission to connect to WebSocket
backend.auth.resources.authenticatedUserIamRole.addToPrincipalPolicy(
  new PolicyStatement({
    effect: Effect.ALLOW,
    actions: ["execute-api:Invoke"],
    resources: [
      `arn:aws:execute-api:*:*:${webSocketApi.apiId}/*`,
    ],
  })
);

backend.addOutput({
  custom: {
    chatUrl: chatFunctionUrl.url,
    chatWsUrl: webSocketStage.url,
  },
});
