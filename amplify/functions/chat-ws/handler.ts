console.log("Initializing WebSocket chat handler");

import { generateClient } from "aws-amplify/data";
import { getAmplifyDataClientConfig } from "@aws-amplify/backend/function/runtime";
import type { Schema } from "../../data/resource";
import { env } from "$amplify/env/chat-ws";
import { Amplify } from "aws-amplify";
import { createClaudeStream } from "../shared/claude";

const { resourceConfig, libraryOptions } = await getAmplifyDataClientConfig(
  env
);

Amplify.configure(resourceConfig, libraryOptions);

const client = generateClient<Schema>({
  authMode: "iam",
});

console.log("Amplify data client configured");

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

  const messages = event.arguments.messages
    .filter((m): m is NonNullable<typeof m> => m !== null && m !== undefined)
    .map((m) => ({
      role: m.role as "user" | "assistant",
      content: m.content,
    }));

  console.log("Starting stream response, messages:", messages.length);

  const startMs = Date.now();
  let ttftMs = 0;
  const stream = createClaudeStream({ messages });

  let fullMessage = "";

  for await (const streamEvent of stream) {
    if (
      streamEvent.type === "content_block_delta" &&
      streamEvent.delta?.type === "text_delta"
    ) {
      fullMessage += streamEvent.delta.text;
      if (!ttftMs && streamEvent.delta.text) {
        ttftMs = Date.now() - startMs;
        console.log("First token received in", ttftMs, "ms");
      }
      await client.models.ChatMessage.update({
        id: agentPendingMessageId,
        content: fullMessage,
      });
    }
  }

  const completionMs = Date.now() - startMs;
  console.log("Stream complete in", completionMs, "ms");
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
