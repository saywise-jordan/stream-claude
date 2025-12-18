import { defineFunction, secret } from "@aws-amplify/backend";

export const chatWs = defineFunction({
  name: "chat-ws",
  environment: {
    ANTHROPIC_API_KEY: secret("ANTHROPIC_API_KEY"),
  },
  runtime: 20,
  timeoutSeconds: 900,
});
