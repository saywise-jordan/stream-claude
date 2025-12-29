import express, { Request, Response, NextFunction } from "express";
import type { Anthropic } from "@anthropic-ai/sdk";
import { CognitoJwtVerifier } from "aws-jwt-verify";
import { createClaudeStream } from "./claude.js";

const app = express();
const PORT = parseInt(process.env.PORT || "3000");

const COGNITO_USER_POOL_ID = process.env.COGNITO_USER_POOL_ID;
const COGNITO_CLIENT_ID = process.env.COGNITO_CLIENT_ID;

let jwtVerifier: ReturnType<typeof CognitoJwtVerifier.create> | null = null;

if (COGNITO_USER_POOL_ID && COGNITO_CLIENT_ID) {
  jwtVerifier = CognitoJwtVerifier.create({
    userPoolId: COGNITO_USER_POOL_ID,
    tokenUse: "access",
    clientId: COGNITO_CLIENT_ID,
  });
  console.log("JWT verification enabled for Cognito User Pool:", COGNITO_USER_POOL_ID);
} else {
  console.warn("JWT verification disabled - COGNITO_USER_POOL_ID or COGNITO_CLIENT_ID not set");
}

const ALLOWED_ORIGINS = [
  "http://localhost:5173",
  "http://localhost:3000",
  "https://main.d13y3nbo34vz7r.amplifyapp.com",
];

app.use((req: Request, res: Response, next: NextFunction) => {
  const origin = req.headers.origin;
  if (origin && ALLOWED_ORIGINS.includes(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
  }
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  res.setHeader("Access-Control-Allow-Credentials", "true");
  next();
});

app.options("*", (_req: Request, res: Response) => {
  res.sendStatus(204);
});

app.use(express.json());

interface AuthenticatedRequest extends Request {
  user?: {
    sub: string;
    username: string;
  };
}

async function authenticateToken(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
): Promise<void> {
  if (!jwtVerifier) {
    next();
    return;
  }

  const authHeader = req.headers.authorization;
  const token = authHeader?.startsWith("Bearer ") ? authHeader.slice(7) : null;

  if (!token) {
    res.status(401).json({ error: "Authorization token required" });
    return;
  }

  try {
    const payload = await jwtVerifier.verify(token);
    req.user = {
      sub: payload.sub,
      username: payload.username as string,
    };
    next();
  } catch (error) {
    console.error("JWT verification failed:", error);
    res.status(403).json({ error: "Invalid or expired token" });
  }
}

app.get("/health", (_req: Request, res: Response) => {
  res.json({ status: "healthy", protocols: ["sse"], authEnabled: !!jwtVerifier });
});

app.post("/chat", authenticateToken, async (req: AuthenticatedRequest, res: Response) => {
  console.log("[SSE] Received chat request", req.user ? `from user: ${req.user.sub}` : "");

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders();

  let messages: Anthropic.MessageParam[] = [];
  let simulate = false;

  try {
    if (req.body?.messages && Array.isArray(req.body.messages)) {
      messages = req.body.messages;
    }
    if (req.body?.simulate === true) {
      simulate = true;
    }
  } catch (parseError) {
    console.error("[SSE] Failed to parse request body:", parseError);
  }

  if (messages.length === 0) {
    res.write(`data: ${JSON.stringify({ error: "No messages provided" })}\n\n`);
    res.end();
    return;
  }

  console.log("[SSE] Starting stream, messages:", messages.length, "simulate:", simulate);

  const startMs = Date.now();
  let ttftMs = 0;
  let streamStarted = false;
  const stream = createClaudeStream({ messages, simulate });

  req.on("close", () => {
    if (streamStarted) {
      console.log("[SSE] Client disconnected, aborting stream");
      stream.abort();
    }
  });

  try {
    for await (const streamEvent of stream) {
      streamStarted = true;
      if (
        streamEvent.type === "content_block_delta" &&
        "delta" in streamEvent &&
        streamEvent.delta?.type === "text_delta"
      ) {
        if (!ttftMs && "text" in streamEvent.delta && streamEvent.delta.text) {
          ttftMs = Date.now() - startMs;
          console.log("[SSE] First token received in", ttftMs, "ms");
        }
      }
      try {
        res.write(`event: ${streamEvent.type}\n`);
        res.write(`data: ${JSON.stringify(streamEvent)}\n\n`);
      } catch {
        console.log("[SSE] Failed to write, client likely disconnected");
        stream.abort();
        break;
      }
    }
    const completionMs = Date.now() - startMs;
    console.log("[SSE] Stream complete in", completionMs, "ms");
    res.write(`event: stats\n`);
    res.write(
      `data: ${JSON.stringify({
        stats: { ttftMs, completionMs },
      })}\n\n`
    );
    res.end();
  } catch (streamError) {
    console.error("[SSE] Stream error:", streamError);
    stream.abort();
    try {
      res.write(`data: ${JSON.stringify({ error: "Stream failed" })}\n\n`);
      res.end();
    } catch {
      console.log("[SSE] Failed to write error response");
    }
  }
});

app.listen(PORT, () => {
  console.log(`Chat server running on port ${PORT}`);
  console.log(`  SSE endpoint: POST http://localhost:${PORT}/chat`);
  console.log(`  Auth: ${jwtVerifier ? "enabled" : "disabled"}`);
});
