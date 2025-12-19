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
import { Stack } from "aws-cdk-lib";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import * as apigatewayv2 from "aws-cdk-lib/aws-apigatewayv2";
import { WebSocketLambdaIntegration } from "aws-cdk-lib/aws-apigatewayv2-integrations";

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

backend.addOutput({
  custom: {
    chatUrl: chatFunctionUrl.url,
    chatWebSocketUrl: webSocketStage.url,
  },
});
