import { Anthropic } from "@anthropic-ai/sdk";

const client = new Anthropic({
  apiKey: process.env["ANTHROPIC_API_KEY"],
});

async function chatClaudeStream(messages: Anthropic.MessageParam[]) {
  const stream = await client.messages.create({
    max_tokens: 1024,
    messages,
    model: "claude-sonnet-4-5-20250929",
    stream: true,
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

    // Assign to the responseStream parameter to prevent accidental reuse of the non-wrapped stream.
    responseStream = awslambda.HttpResponseStream.from(
      responseStream,
      metadata
    );

    try {
      const stream = await chatClaudeStream([
        {
          role: "user",
          content: "Hello, how are you?",
        },
      ]);

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
