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
  authType: FunctionUrlAuthType.NONE,
  invokeMode: InvokeMode.RESPONSE_STREAM,
  cors: {
    allowedOrigins: ["http://localhost:5173"],
    allowedMethods: [HttpMethod.POST],
    allowedHeaders: ["*"],
  },
});

backend.addOutput({
  custom: {
    chatUrl: chatFunctionUrl.url,
  },
});
