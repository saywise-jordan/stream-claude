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

const { resourceConfig, libraryOptions } = await getAmplifyDataClientConfig(
  env
);

Amplify.configure(resourceConfig, libraryOptions);

const client = generateClient<Schema>({
  authMode: "iam",
});

export const handler: Schema["chat"]["functionHandler"] = async (event) => {
  console.log("Event", event);
  const sessionId = event.arguments.sessionId;
  const messageId = event.arguments.messageId;

  const agentPendingMessage = await client.models.ChatMessage.create({
    id: messageId,
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
  const startMs = Date.now();
  let ttftMs = 0;
  let completionMs = 0;

  const messagesForClaude = event.arguments.messages
    .filter((m): m is NonNullable<typeof m> => m !== null && m !== undefined)
    .map((m) => ({
      role: m.role as "user" | "assistant",
      content: m.content,
    }));

  const stream = anthropicClient.messages.stream({
    model: "claude-sonnet-4-5-20250929",
    max_tokens: 2048,
    messages: messagesForClaude,
  });

  let fullMessage = "";

  for await (const event of stream) {
    console.log("Event", event);
    if (
      event.type === "content_block_delta" &&
      event.delta?.type === "text_delta"
    ) {
      fullMessage += event.delta.text;
      if (!ttftMs) {
        ttftMs = Date.now() - startMs;
      }
      await client.models.ChatMessage.update({
        id: agentPendingMessageId,
        content: fullMessage,
      });
    }
  }

  completionMs = Date.now() - startMs;
  const updated = await client.models.ChatMessage.update({
    id: agentPendingMessageId,
    isStreaming: false,
    isComplete: true,
    tokenCount: fullMessage.length,
    ttftMs: ttftMs,
    completionMs: completionMs,
  });

  console.log("Agent response complete", agentPendingMessageId);
  return updated.data;
};
