import { defineBackend } from "@aws-amplify/backend";
import { auth } from "./auth/resource";
import { data } from "./data/resource";
import { chat } from "./functions/chat/resource";

defineBackend({
  auth,
  data,
  chat,
});
