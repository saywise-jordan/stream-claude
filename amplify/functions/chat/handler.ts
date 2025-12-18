console.log("Initializing chat handler");

import type { Anthropic } from "@anthropic-ai/sdk";
import { createClaudeStream } from "../shared/claude";

console.log("Chat handler initialized");

export const handler = awslambda.streamifyResponse(
  async (event, responseStream, context) => {
    console.log("Event:", { event });
    console.log("Context:", { context });
    const metadata = {
      statusCode: 200,
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      },
    };

    responseStream = awslambda.HttpResponseStream.from(
      responseStream,
      metadata
    );

    try {
      let messages: Anthropic.MessageParam[] = [];

      if (event.body) {
        try {
          const body = JSON.parse(event.body);
          if (body.messages && Array.isArray(body.messages)) {
            messages = body.messages;
          }
        } catch (parseError) {
          console.error("Failed to parse request body:", parseError);
        }
      }

      if (messages.length === 0) {
        responseStream.write(
          `data: ${JSON.stringify({ error: "No messages provided" })}\n\n`
        );
        responseStream.end();
        return;
      }

      console.log("Starting stream response, messages:", messages.length);

      const startMs = Date.now();
      let ttftMs = 0;
      const stream = createClaudeStream({ messages });

      try {
        for await (const streamEvent of stream) {
          if (
            streamEvent.type === "content_block_delta" &&
            streamEvent.delta?.type === "text_delta"
          ) {
            if (!ttftMs && streamEvent.delta.text) {
              ttftMs = Date.now() - startMs;
              console.log("First token received in", ttftMs, "ms");
            }
          }
          try {
            responseStream.write(`event: ${streamEvent.type}\n`);
            responseStream.write(`data: ${JSON.stringify(streamEvent)}\n\n`);
          } catch (writeError) {
            console.log("Client disconnected, aborting stream");
            stream.abort();
            break;
          }
        }
        const completionMs = Date.now() - startMs;
        console.log("Stream complete in", completionMs, "ms");
        responseStream.write(`event: stats\n`);
        responseStream.write(
          `data: ${JSON.stringify({
            stats: {
              ttftMs,
              completionMs,
            },
          })}\n\n`
        );
        responseStream.end();
      } catch (streamError) {
        console.error("Stream error:", streamError);
        stream.abort();
        throw streamError;
      }
    } catch (error) {
      console.error("Handler error:", error);
      try {
        responseStream.write(
          `data: ${JSON.stringify({ error: "Stream failed" })}\n\n`
        );
        responseStream.end();
      } catch (e) {
        console.log(
          "Failed to write error response, client likely disconnected"
        );
      }
    }
  }
);
