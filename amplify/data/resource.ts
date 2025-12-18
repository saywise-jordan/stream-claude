import { type ClientSchema, a, defineData } from "@aws-amplify/backend";
import { chatWs } from "../functions/chat-ws/resource";

/*== CHAT STREAMING MODEL =================================================
This schema supports real-time streaming chat messages via AppSync subscriptions.
Messages can be updated incrementally as content arrives from the AI.
=========================================================================*/
const schema = a
  .schema({
    ChatSession: a
      .model({
        title: a.string(),
        createdAt: a.datetime(),
        messages: a.hasMany("ChatMessage", "sessionId"),
      })
      .authorization((allow) => [allow.owner()]),
    ChatMessage: a
      .model({
        sessionId: a.string().required(),
        session: a.belongsTo("ChatSession", "sessionId"),
        role: a.enum(["user", "assistant", "system"]),
        content: a.string().required(),
        isStreaming: a.boolean().default(false),
        isComplete: a.boolean().default(false),
        tokenCount: a.integer(),
        createdAt: a.datetime(),
        updatedAt: a.datetime(),
      })
      .authorization((allow) => [allow.owner()]),
    Todo: a
      .model({
        content: a.string(),
      })
      .authorization((allow) => [allow.owner()]),
    chat: a
      .mutation()
      .arguments({
        sessionId: a.id(),
        message: a.string().required(),
      })
      .returns(a.boolean())
      .handler(a.handler.function(chatWs))
      .authorization((allow) => [allow.authenticated()]),
  })
  .authorization((allow) => [allow.resource(chatWs)]);

export type Schema = ClientSchema<typeof schema>;

export const data = defineData({
  schema,
  authorizationModes: {
    defaultAuthorizationMode: "apiKey",
    // API Key is used for a.allow.public() rules
    apiKeyAuthorizationMode: {
      expiresInDays: 30,
    },
  },
});

/*== STEP 2 ===============================================================
Go to your frontend source code. From your client-side code, generate a
Data client to make CRUDL requests to your table. (THIS SNIPPET WILL ONLY
WORK IN THE FRONTEND CODE FILE.)

Using JavaScript or Next.js React Server Components, Middleware, Server 
Actions or Pages Router? Review how to generate Data clients for those use
cases: https://docs.amplify.aws/gen2/build-a-backend/data/connect-to-API/
=========================================================================*/

/*
"use client"
import { generateClient } from "aws-amplify/data";
import type { Schema } from "@/amplify/data/resource";

const client = generateClient<Schema>() // use this Data client for CRUDL requests
*/

/*== STEP 3 ===============================================================
Fetch records from the database and use them in your frontend component.
(THIS SNIPPET WILL ONLY WORK IN THE FRONTEND CODE FILE.)
=========================================================================*/

/* For example, in a React component, you can use this snippet in your
  function's RETURN statement */
// const { data: todos } = await client.models.Todo.list()

// return <ul>{todos.map(todo => <li key={todo.id}>{todo.content}</li>)}</ul>
