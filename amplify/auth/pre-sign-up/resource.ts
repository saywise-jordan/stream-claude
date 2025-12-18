import { defineFunction } from '@aws-amplify/backend';

export const preSignUp = defineFunction({
  name: "pre-sign-up",
  runtime: 20,
  memoryMB: 128,
  timeoutSeconds: 10,
});