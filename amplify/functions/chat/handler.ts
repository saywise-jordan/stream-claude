console.log("Initializing chat handler");

import { Anthropic } from "@anthropic-ai/sdk";

const client = new Anthropic({
  apiKey: process.env["ANTHROPIC_API_KEY"],
});

console.log("Anthropic client initialized");

function chatClaudeStream(messages: Anthropic.MessageParam[]) {
  const stream = client.messages.stream({
    max_tokens: 2048,
    messages,
    model: "claude-sonnet-4-5-20250929",
    system:
      "You are a helpful AI assistant. You provide clear, accurate, and thoughtful responses to user questions. You are concise but thorough, and you acknowledge when you're uncertain about something. You aim to be conversational yet professional.",
  });
  return stream;
}

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

      console.log("messages:", messages.length);

      const start = new Date();
      let firstTokenMs = 0;
      const stream = chatClaudeStream(messages);

      try {
        for await (const event of stream) {
          if (
            !firstTokenMs &&
            event.type === "content_block_delta" &&
            event.delta?.type === "text_delta" &&
            event.delta.text
          ) {
            firstTokenMs = new Date().getTime() - start.getTime();
            console.log("First token received in", firstTokenMs, "ms");
          }
          try {
            responseStream.write(`event: ${event.type}\n`);
            responseStream.write(`data: ${JSON.stringify(event)}\n\n`);
          } catch (writeError) {
            console.log("Client disconnected, aborting stream");
            stream.abort();
            break;
          }
        }
        const endMs = new Date().getTime() - start.getTime();
        console.log("Stream ended in", endMs, "ms");
        responseStream.write(`event: stats\n`);
        responseStream.write(
          `data: ${JSON.stringify({
            stats: {
              firstTokenMs,
              endMs,
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
