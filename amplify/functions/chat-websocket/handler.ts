import {
  APIGatewayProxyWebsocketHandlerV2,
  APIGatewayProxyResultV2,
} from "aws-lambda";
import {
  ApiGatewayManagementApiClient,
  PostToConnectionCommand,
} from "@aws-sdk/client-apigatewaymanagementapi";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  PutCommand,
  DeleteCommand,
} from "@aws-sdk/lib-dynamodb";
import { createClaudeStream } from "../shared/claude";

const ddbClient = new DynamoDBClient({});
const docClient = DynamoDBDocumentClient.from(ddbClient);

const TABLE_NAME = process.env.CONNECTIONS_TABLE_NAME || "";

interface SendMessageBody {
  action: "sendMessage";
  messages: Array<{ role: "user" | "assistant"; content: string }>;
  simulate?: boolean;
}

async function handleConnect(
  connectionId: string
): Promise<APIGatewayProxyResultV2> {
  console.log("WebSocket connect:", connectionId);

  await docClient.send(
    new PutCommand({
      TableName: TABLE_NAME,
      Item: {
        connectionId,
        connectedAt: Date.now(),
      },
    })
  );

  return { statusCode: 200, body: "Connected" };
}

async function handleDisconnect(
  connectionId: string
): Promise<APIGatewayProxyResultV2> {
  console.log("WebSocket disconnect:", connectionId);

  await docClient.send(
    new DeleteCommand({
      TableName: TABLE_NAME,
      Key: { connectionId },
    })
  );

  return { statusCode: 200, body: "Disconnected" };
}

async function handleSendMessage(
  connectionId: string,
  endpoint: string,
  body: SendMessageBody
): Promise<APIGatewayProxyResultV2> {
  console.log("WebSocket sendMessage:", connectionId, "messages:", body.messages?.length);

  const apiGwClient = new ApiGatewayManagementApiClient({
    endpoint,
  });

  const sendToConnection = async (data: object) => {
    try {
      await apiGwClient.send(
        new PostToConnectionCommand({
          ConnectionId: connectionId,
          Data: Buffer.from(JSON.stringify(data)),
        })
      );
    } catch (error: unknown) {
      if ((error as { statusCode?: number }).statusCode === 410) {
        console.log("Connection stale, removing:", connectionId);
        await docClient.send(
          new DeleteCommand({
            TableName: TABLE_NAME,
            Key: { connectionId },
          })
        );
      } else {
        throw error;
      }
    }
  };

  const messages = body.messages || [];
  const simulate = body.simulate ?? false;

  if (messages.length === 0) {
    await sendToConnection({ type: "error", message: "No messages provided" });
    return { statusCode: 400, body: "No messages provided" };
  }

  const startMs = Date.now();
  let ttftMs = 0;

  try {
    const stream = createClaudeStream({ messages, simulate });

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

      await sendToConnection({
        type: "stream",
        event: streamEvent,
      });
    }

    const completionMs = Date.now() - startMs;
    console.log("Stream complete in", completionMs, "ms");

    await sendToConnection({
      type: "stats",
      stats: {
        ttftMs,
        completionMs,
      },
    });

    await sendToConnection({ type: "done" });

    return { statusCode: 200, body: "Message sent" };
  } catch (error) {
    console.error("Stream error:", error);
    await sendToConnection({
      type: "error",
      message: "Stream failed",
    });
    return { statusCode: 500, body: "Stream failed" };
  }
}

export const handler: APIGatewayProxyWebsocketHandlerV2 = async (event) => {
  console.log("WebSocket event:", JSON.stringify(event, null, 2));

  const connectionId = event.requestContext.connectionId;
  const routeKey = event.requestContext.routeKey;
  const domainName = event.requestContext.domainName;
  const stage = event.requestContext.stage;
  const endpoint = `https://${domainName}/${stage}`;

  switch (routeKey) {
    case "$connect":
      return handleConnect(connectionId);

    case "$disconnect":
      return handleDisconnect(connectionId);

    case "sendMessage":{
      const body = event.body ? JSON.parse(event.body) : {};
      return handleSendMessage(connectionId, endpoint, body);
    }

    default:
      console.log("Unknown route:", routeKey);
      return { statusCode: 400, body: "Unknown route" };
  }
};
