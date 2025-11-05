import { Anthropic } from "@anthropic-ai/sdk";

const client = new Anthropic({
  apiKey: process.env["ANTHROPIC_API_KEY"],
});

async function chatClaudeStream(messages: Anthropic.MessageParam[]) {
  const stream = await client.messages.create({
    max_tokens: 2048,
    messages,
    model: "claude-sonnet-4-5-20250929",
    stream: true,
    system: "You are a helpful AI assistant. You provide clear, accurate, and thoughtful responses to user questions. You are concise but thorough, and you acknowledge when you're uncertain about something. You aim to be conversational yet professional.",
  });
  return stream;
}

export const handler = awslambda.streamifyResponse(
  async (event, responseStream) => {
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

      console.log("Event:", event);

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

      const stream = await chatClaudeStream(messages);

      for await (const event of stream) {
        if (
          event.type === "content_block_delta" &&
          event.delta.type === "text_delta"
        ) {
          responseStream.write(
            `data: ${JSON.stringify({ text: event.delta.text })}\n\n`
          );
        }
      }

      responseStream.write("data: [DONE]\n\n");
      responseStream.end();
    } catch (error) {
      console.error("Stream error:", error);
      responseStream.write(
        `data: ${JSON.stringify({ error: "Stream failed" })}\n\n`
      );
      responseStream.end();
    }
  }
);
