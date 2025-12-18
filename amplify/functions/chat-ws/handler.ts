console.log("Initializing WebSocket chat handler");

import { Anthropic } from "@anthropic-ai/sdk";
import { generateClient } from "aws-amplify/data";
import { getAmplifyDataClientConfig } from "@aws-amplify/backend/function/runtime";
import type { Schema } from "../../data/resource";
import { env } from "$amplify/env/chat-ws";
import { Amplify } from "aws-amplify";

const anthropicClient = new Anthropic({
  apiKey: process.env["ANTHROPIC_API_KEY"],
});

const { resourceConfig } = await getAmplifyDataClientConfig(env);

Amplify.configure(resourceConfig);

const client = generateClient<Schema>({
  authMode: "iam",
});

export const handler: Schema["chat"]["functionHandler"] = async (event) => {
  console.log("Event", event);
  let sessionId = event.arguments.sessionId;

  if (!event.arguments.sessionId) {
    const session = await client.models.ChatSession.create({
      title: "New Session",
    });

    if (!session.data?.id) {
      throw new Error("Failed to create session");
    }

    sessionId = session.data?.id;
  }

  if (!sessionId) {
    throw new Error("Session ID is required");
  }

  await client.models.ChatMessage.create({
    sessionId: sessionId,
    content: event.arguments.message,
    role: "user",
  });

  const agentPendingMessage = await client.models.ChatMessage.create({
    sessionId: sessionId,
    content: "Thinking...",
    role: "assistant",
    isStreaming: true,
    isComplete: false,
  });

  if (!agentPendingMessage.data?.id) {
    throw new Error("Failed to create agent pending message");
  }

  const agentPendingMessageId = agentPendingMessage.data?.id;

  console.log("Starting agent response", agentPendingMessageId);

  const stream = anthropicClient.messages.stream({
    model: "claude-sonnet-4-5-20250929",
    max_tokens: 2048,
    messages: [
      {
        role: "user",
        content: event.arguments.message,
      },
    ],
  });

  let fullMessage = "";

  for await (const event of stream) {
    console.log("Event", event);
    if (
      event.type === "content_block_delta" &&
      event.delta?.type === "text_delta"
    ) {
      fullMessage += event.delta.text;
      await client.models.ChatMessage.update({
        id: agentPendingMessageId,
        content: fullMessage,
      });
    }
  }

  await client.models.ChatMessage.update({
    id: agentPendingMessageId,
    content: fullMessage,
    isStreaming: false,
    isComplete: true,
    tokenCount: fullMessage.length,
  });

  console.log("Agent response complete", agentPendingMessageId);
  return true;
};
