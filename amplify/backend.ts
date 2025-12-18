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

backend.addOutput({
  custom: {
    chatUrl: chatFunctionUrl.url,
  },
});
