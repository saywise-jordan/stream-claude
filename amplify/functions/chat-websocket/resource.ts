import { defineFunction, secret } from "@aws-amplify/backend";

export const chatWebsocket = defineFunction({
  name: "chat-websocket",
  environment: {
    ANTHROPIC_API_KEY: secret("ANTHROPIC_API_KEY"),
  },
  runtime: 20,
  timeoutSeconds: 900,
});
