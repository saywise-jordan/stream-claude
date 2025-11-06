import { defineBackend } from "@aws-amplify/backend";
import { auth } from "./auth/resource";
import { data } from "./data/resource";
import { chat } from "./functions/chat/resource";
import {
  FunctionUrlAuthType,
  HttpMethod,
  InvokeMode,
} from "aws-cdk-lib/aws-lambda";

const backend = defineBackend({
  auth,
  data,
  chat,
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

backend.addOutput({
  custom: {
    chatUrl: chatFunctionUrl.url,
  },
});
