import { defineFunction, secret } from "@aws-amplify/backend";

export const chat = defineFunction({
  name: "chat",
  environment: {
    ANTHROPIC_API_KEY: secret("ANTHROPIC_API_KEY"),
  },
  timeoutSeconds: 900,
});
