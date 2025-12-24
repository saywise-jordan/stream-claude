import { defineAuth, secret } from "@aws-amplify/backend";
import { preSignUp } from "./pre-sign-up/resource";

/**
 * Define and configure your auth resource
 * @see https://docs.amplify.aws/gen2/build-a-backend/auth
 */
export const auth = defineAuth({
  loginWith: {
    email: true,
    externalProviders: {
      google: {
        clientId: secret("GOOGLE_CLIENT_ID"),
        clientSecret: secret("GOOGLE_CLIENT_SECRET"),
        scopes: ["profile", "email", "openid"],
      },
      callbackUrls: [
        "http://localhost:5173/",
        "http://localhost:3000/",
        "https://main.d13y3nbo34vz7r.amplifyapp.com/",
      ],
      logoutUrls: [
        "http://localhost:5173/",
        "http://localhost:3000/",
        "https://main.d13y3nbo34vz7r.amplifyapp.com/",
      ],
    },
  },
  triggers: {
    preSignUp: preSignUp,
  },
});
