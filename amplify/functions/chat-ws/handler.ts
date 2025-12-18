console.log("Initializing WebSocket chat handler");

import { Anthropic } from "@anthropic-ai/sdk";
import {
  ApiGatewayManagementApiClient,
  PostToConnectionCommand,
} from "@aws-sdk/client-apigatewaymanagementapi";
import {
  DynamoDBClient,
  PutItemCommand,
  DeleteItemCommand,
} from "@aws-sdk/client-dynamodb";

const anthropicClient = new Anthropic({
  apiKey: process.env["ANTHROPIC_API_KEY"],
});

const dynamoClient = new DynamoDBClient({});
const connectionsTableName = process.env["CONNECTIONS_TABLE_NAME"];

console.log("Anthropic client initialized");

function chatClaudeStream(messages: Anthropic.MessageParam[]) {
  const stream = anthropicClient.messages.stream({
    max_tokens: 2048,
    messages,
    model: "claude-sonnet-4-5-20250929",
    system:
      "You are a helpful AI assistant. You provide clear, accurate, and thoughtful responses to user questions. You are concise but thorough, and you acknowledge when you're uncertain about something. You aim to be conversational yet professional.",
  });
  return stream;
}

interface WebSocketEvent {
  requestContext: {
    connectionId: string;
    domainName: string;
    stage: string;
    routeKey: string;
  };
  body?: string;
}

export const handler = async (event: WebSocketEvent) => {
  console.log("Event:", { event });

  const { connectionId, domainName, stage, routeKey } = event.requestContext;

  // Create API Gateway Management API client for posting messages back to the connection
  const endpoint = process.env["WEBSOCKET_API_ENDPOINT"] || `https://${domainName}/${stage}`;
  const apiGatewayClient = new ApiGatewayManagementApiClient({
    endpoint,
  });

  const postToConnection = async (data: any) => {
    try {
      await apiGatewayClient.send(
        new PostToConnectionCommand({
          ConnectionId: connectionId,
          Data: JSON.stringify(data),
        })
      );
    } catch (error: any) {
      if (error.statusCode === 410) {
        console.log("Connection gone, client disconnected");
        return false;
      }
      throw error;
    }
    return true;
  };

  // Handle different WebSocket routes
  if (routeKey === "$connect") {
    // Store connection in DynamoDB
    if (connectionsTableName) {
      try {
        await dynamoClient.send(
          new PutItemCommand({
            TableName: connectionsTableName,
            Item: {
              connectionId: { S: connectionId },
              connectedAt: { N: Date.now().toString() },
            },
          })
        );
        console.log(`Connection ${connectionId} stored in DynamoDB`);
      } catch (error) {
        console.error("Failed to store connection:", error);
      }
    }
    return { statusCode: 200, body: "Connected" };
  }

  if (routeKey === "$disconnect") {
    // Remove connection from DynamoDB
    if (connectionsTableName) {
      try {
        await dynamoClient.send(
          new DeleteItemCommand({
            TableName: connectionsTableName,
            Key: {
              connectionId: { S: connectionId },
            },
          })
        );
        console.log(`Connection ${connectionId} removed from DynamoDB`);
      } catch (error) {
        console.error("Failed to remove connection:", error);
      }
    }
    return { statusCode: 200, body: "Disconnected" };
  }

  // Handle the chat message route
  if (routeKey === "chat" || routeKey === "$default") {
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
          await postToConnection({ error: "Invalid request body" });
          return { statusCode: 400, body: "Invalid request" };
        }
      }

      if (messages.length === 0) {
        await postToConnection({ error: "No messages provided" });
        return { statusCode: 400, body: "No messages provided" };
      }

      console.log("messages:", messages);

      const start = new Date();
      let firstTokenMs = 0;
      const stream = chatClaudeStream(messages);

      try {
        for await (const streamEvent of stream) {
          if (
            !firstTokenMs &&
            streamEvent.type === "content_block_delta" &&
            streamEvent.delta?.type === "text_delta"
          ) {
            firstTokenMs = new Date().getTime() - start.getTime();
            console.log("First token received in", firstTokenMs, "ms");
          }

          const success = await postToConnection({
            type: streamEvent.type,
            data: streamEvent,
          });

          if (!success) {
            console.log("Client disconnected, aborting stream");
            stream.abort();
            break;
          }
        }

        const endMs = new Date().getTime() - start.getTime();
        console.log("Stream ended in", endMs, "ms");

        await postToConnection({
          type: "stats",
          data: {
            stats: {
              firstTokenMs,
              endMs,
            },
          },
        });

        return { statusCode: 200, body: "Stream completed" };
      } catch (streamError) {
        console.error("Stream error:", streamError);
        stream.abort();
        await postToConnection({ error: "Stream failed" });
        return { statusCode: 500, body: "Stream failed" };
      }
    } catch (error) {
      console.error("Handler error:", error);
      try {
        await postToConnection({ error: "Request failed" });
      } catch (e) {
        console.log("Failed to send error response, client likely disconnected");
      }
      return { statusCode: 500, body: "Internal error" };
    }
  }

  return { statusCode: 400, body: "Invalid route" };
};
