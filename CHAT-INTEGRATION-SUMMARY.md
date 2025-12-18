# Chat Streaming Integration Summary

## Overview

Your chat system now has **dual real-time streaming**:
1. **WebSocket** for immediate token-by-token feedback
2. **AppSync Subscriptions** for persistent, multi-client synchronized updates

## Architecture

```
┌─────────┐         ┌──────────────┐         ┌─────────────┐
│ Client  │────────>│  WebSocket   │────────>│   Lambda    │
│         │<────────│     API      │<────────│  (chat-ws)  │
└─────────┘         └──────────────┘         └──────┬──────┘
     │                                              │
     │                                              │
     │              ┌──────────────┐                │
     │              │   AppSync    │                │
     └─────────────>│ Subscriptions│<───────────────┘
                    │   GraphQL    │
                    └──────────────┘
                           │
                           ▼
                    ┌──────────────┐
                    │   DynamoDB   │
                    │  (Amplify    │
                    │   Data)      │
                    └──────────────┘
```

## Files Modified

### 1. [amplify/data/resource.ts](amplify/data/resource.ts)
Added two models:
- **ChatSession**: Groups messages together
- **ChatMessage**: Individual messages with streaming support

Key fields:
- `content`: Message text (updated incrementally)
- `isStreaming`: Boolean flag for streaming state
- `isComplete`: Boolean flag for completion
- `tokenCount`: Track number of tokens/chunks

### 2. [amplify/backend.ts](amplify/backend.ts:89-106)
Granted permissions:
- Lambda can call AppSync GraphQL mutations
- Lambda can create/update ChatMessage and ChatSession

### 3. [amplify/functions/chat-ws/handler.ts](amplify/functions/chat-ws/handler.ts)
Complete rewrite to:
- Accept optional `sessionId` and `userId`
- Create session if not provided
- Save user messages to database
- Create assistant message with `isStreaming: true`
- Update message on every token (triggers AppSync!)
- Mark complete when done

## How It Works

### Message Flow

1. **Client sends message** via WebSocket:
```json
{
  "messages": [{ "role": "user", "content": "Hello" }],
  "sessionId": "optional-session-id",
  "userId": "optional-user-id"
}
```

2. **Lambda processes**:
   - Creates/uses ChatSession
   - Saves user message to database
   - Creates assistant message with empty content
   - Streams from Claude API

3. **On each token**:
   - Lambda accumulates content
   - Updates database message ← **Triggers AppSync subscription!**
   - Sends via WebSocket ← Immediate feedback

4. **On completion**:
   - Lambda marks `isStreaming: false`, `isComplete: true`
   - Sends stats via WebSocket
   - Database has complete message

### Client Setup

```typescript
// 1. Setup WebSocket
const ws = new WebSocket(webSocketUrl);
let sessionId: string;

ws.onmessage = (event) => {
  const data = JSON.parse(event.data);
  if (data.type === "session_created") {
    sessionId = data.data.sessionId;
  }
};

// 2. Setup AppSync subscription
const subscription = dataClient.models.ChatMessage.onUpdate({
  filter: { sessionId: { eq: sessionId } }
}).subscribe({
  next: (message) => {
    // Update UI with message.content
    // message.isStreaming tells you if still generating
  }
});

// 3. Send message
ws.send(JSON.stringify({
  messages: [{ role: "user", content: "Hello" }],
  sessionId,
  userId: "user-123"
}));
```

## Key Benefits

### 1. **Dual Streaming**
- WebSocket: Instant token delivery
- AppSync: Persistent, synced across clients

### 2. **Multi-Client Support**
- Multiple clients can subscribe to same session
- All see real-time updates via AppSync
- Perfect for collaborative viewing

### 3. **Resume Capability**
- Messages stored in database
- Can reload conversation history
- Works across page refreshes

### 4. **Offline Support**
- Can queue messages when offline
- AppSync subscriptions reconnect automatically
- Message history available from database

### 5. **Audit Trail**
- Complete message history
- Timestamps for every update
- Token counts for analytics

## Usage Examples

### Start New Chat
```typescript
ws.send(JSON.stringify({
  messages: [{ role: "user", content: "Hello" }],
  userId: "user-123"
  // No sessionId = creates new session
}));
```

### Continue Existing Chat
```typescript
ws.send(JSON.stringify({
  messages: [
    { role: "user", content: "Previous message" },
    { role: "assistant", content: "Previous response" },
    { role: "user", content: "New message" }
  ],
  sessionId: existingSessionId,
  userId: "user-123"
}));
```

### Load Message History
```typescript
const { data: messages } = await dataClient.models.ChatMessage.list({
  filter: { sessionId: { eq: sessionId } }
});

// Sort by createdAt
messages.sort((a, b) =>
  new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime()
);
```

## Performance Considerations

### Current Behavior
- Updates database on **every token**
- This triggers AppSync subscription on each token
- Provides maximum real-time responsiveness

### Optimization Options

If you need to reduce database writes:

```typescript
// Option 1: Batch updates every N tokens
if (tokenCount % 10 === 0) {
  await dataClient.models.ChatMessage.update({...});
}

// Option 2: Time-based batching (every 100ms)
const now = Date.now();
if (now - lastUpdate > 100) {
  await dataClient.models.ChatMessage.update({...});
  lastUpdate = now;
}

// Option 3: Hybrid - WebSocket only, final DB update
// Remove updates from loop, only update on completion
```

## Deployment

1. **Deploy the backend**:
```bash
npx ampx sandbox
# or
npx ampx deploy
```

2. **Get WebSocket URL**:
```bash
# Check amplify_outputs.json after deployment
cat amplify_outputs.json | grep chatWsUrl
```

3. **Test connection**:
```bash
# Use wscat or similar
wscat -c "wss://your-websocket-url"
```

## Monitoring

### CloudWatch Logs
- Lambda logs show session/message creation
- Token timing statistics
- Error tracking

### AppSync Metrics
- Subscription connections
- Mutation rate
- Data transfer

### DynamoDB Metrics
- Read/write capacity
- Item counts
- Latency

## Next Steps

1. **Add authentication**: Use Cognito user tokens for `userId`
2. **Add message filtering**: Filter by role, date, etc.
3. **Add session management**: List sessions, delete old sessions
4. **Add rate limiting**: Prevent abuse
5. **Add cost tracking**: Monitor token usage per user
6. **Add conversation titles**: Auto-generate from first message
7. **Add message reactions**: Store in separate table
8. **Add file attachments**: Store in S3, reference in messages

## Documentation

- [Data Schema](amplify/data/resource.ts) - Database models
- [WebSocket Handler](amplify/functions/chat-ws/handler.ts) - Lambda implementation
- [Client Example](amplify/functions/chat-ws/CLIENT-EXAMPLE.md) - How to use from client
- [Streaming Example](amplify/data/chat-streaming-example.ts) - AppSync subscription patterns
- [Streaming README](amplify/data/STREAMING-CHAT-README.md) - Detailed AppSync guide

## Troubleshooting

### Messages not appearing in database
- Check Lambda CloudWatch logs for errors
- Verify IAM permissions in backend.ts
- Check AppSync API is deployed

### Subscriptions not triggering
- Verify sessionId matches
- Check filter syntax
- Ensure user is authenticated (if using auth)

### WebSocket disconnects
- Lambda timeout is 900s (15 min)
- Check client network stability
- Implement reconnection logic

### Slow updates
- Check Lambda cold start
- Monitor DynamoDB throttling
- Consider provisioned capacity for DynamoDB
