import { useEffect, useState, useRef } from "react";
import { generateClient } from "aws-amplify/data";
import type { Schema } from "../../amplify/data/resource";
import { Send, Square, MessageCircle } from "lucide-react";
import { Amplify } from "aws-amplify";
import amplifyOutputs from "../../amplify_outputs.json";

Amplify.configure(amplifyOutputs);

interface Message {
  id: string;
  role: "user" | "assistant";
  content: string;
  isStreaming?: boolean;
  isComplete?: boolean;
  ttftMs?: number;
  completionMs?: number;
  clientTtftMs?: number;
}

const client = generateClient<Schema>({
  authMode: "userPool",
});

export function SubscriptionChat() {
  const [messages, setMessages] = useState<Message[]>([]);
  const [userInput, setUserInput] = useState<string>("");
  const [isStreaming, setIsStreaming] = useState<boolean>(false);
  const [sessionId, setSessionId] = useState<string>(() => crypto.randomUUID());
  const messagesEndRef = useRef<HTMLDivElement | null>(null);
  const createSubRef = useRef<{ unsubscribe: () => void } | null>(null);
  const updateSubRef = useRef<{ unsubscribe: () => void } | null>(null);
  const startTimeRef = useRef<number>(0);
  const firstUpdateReceivedRef = useRef<boolean>(false);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  useEffect(() => {
    return () => {
      createSubRef.current?.unsubscribe();
      updateSubRef.current?.unsubscribe();
    };
  }, []);

  async function sendMessage() {
    if (!userInput.trim() || isStreaming) return;

    const messageToSend = userInput;
    setUserInput("");
    setIsStreaming(true);

    const userMessage: Message = {
      id: `user-${Date.now()}`,
      role: "user",
      content: messageToSend,
    };
    setMessages((prev) => [...prev, userMessage]);

    try {
      if (!sessionId) {
        throw new Error("Session ID is required");
      }

      const messageId = crypto.randomUUID();

      setMessages((prev) => [
        ...prev,
        {
          id: messageId,
          role: "assistant",
          content: "Thinking...",
          isStreaming: true,
          isComplete: false,
        },
      ]);

      subscribeToMessage(messageId);

      startTimeRef.current = Date.now();
      firstUpdateReceivedRef.current = false;

      const { errors } = await client.mutations.chat({
        sessionId: sessionId,
        messageId: messageId,
        messages: [...messages, userMessage].map((m) => ({
          role: m.role,
          content: m.content,
        })),
      });

      if (errors) {
        console.error("Mutation errors:", errors);
        setMessages((prev) => prev.filter((m) => m.id !== messageId));
        setIsStreaming(false);
        createSubRef.current?.unsubscribe();
        updateSubRef.current?.unsubscribe();
      }
    } catch (error) {
      console.error("Error sending message:", error);
      setIsStreaming(false);
    }
  }

  function subscribeToMessage(messageId: string) {
    createSubRef.current?.unsubscribe();
    updateSubRef.current?.unsubscribe();

    subscribeToUpdates(messageId);
  }

  function subscribeToUpdates(messageId: string) {
    console.log("Subscribing to onUpdate for message:", messageId);
    updateSubRef.current?.unsubscribe();
    updateSubRef.current = null;

    const updateSub = client.models.ChatMessage.onUpdate({
      filter: { id: { eq: messageId } },
    }).subscribe({
      next: (updatedMessage) => {
        console.log("Message updated:", updatedMessage);
        if (!updatedMessage) return;

        let clientTtft: number | undefined;
        const hasContent =
          updatedMessage.content && updatedMessage.content !== "Thinking...";
        if (!firstUpdateReceivedRef.current && hasContent) {
          firstUpdateReceivedRef.current = true;
          clientTtft = Date.now() - startTimeRef.current;
        }

        setMessages((prev) =>
          prev.map((msg) =>
            msg.id === messageId
              ? {
                  ...msg,
                  content: updatedMessage.content,
                  isStreaming: updatedMessage.isStreaming || false,
                  isComplete: updatedMessage.isComplete || false,
                  ttftMs: updatedMessage.ttftMs ?? msg.ttftMs,
                  completionMs: updatedMessage.completionMs ?? msg.completionMs,
                  clientTtftMs: clientTtft ?? msg.clientTtftMs,
                }
              : msg
          )
        );

        if (updatedMessage.isComplete) {
          setIsStreaming(false);
          updateSubRef.current?.unsubscribe();
          updateSubRef.current = null;
        }
      },
      error: (error) => {
        console.error("onUpdate subscription error:", error);
        setIsStreaming(false);
      },
    });

    updateSubRef.current = updateSub;
  }

  function stopStreaming() {
    createSubRef.current?.unsubscribe();
    updateSubRef.current?.unsubscribe();
    createSubRef.current = null;
    updateSubRef.current = null;
    setIsStreaming(false);
  }

  function startNewSession() {
    setSessionId(crypto.randomUUID());
    setMessages([]);
  }

  const summarizedStats = (() => {
    const messagesWithStats = messages.filter(
      (m) =>
        m.role === "assistant" && m.isComplete && m.clientTtftMs !== undefined
    );
    if (messagesWithStats.length === 0) return null;

    const clientTTFTs = messagesWithStats.map((m) => m.clientTtftMs || 0);
    const serverTTFTs = messagesWithStats.map((m) => m.ttftMs || 0);
    const networkOverheads = messagesWithStats.map(
      (m) => (m.clientTtftMs || 0) - (m.ttftMs || 0)
    );

    const sum = (arr: number[]) => arr.reduce((a, b) => a + b, 0);
    const avg = (arr: number[]) => Math.round(sum(arr) / arr.length);
    const percentile = (arr: number[], p: number) => {
      const sorted = [...arr].sort((a, b) => a - b);
      const index = Math.ceil((p / 100) * sorted.length) - 1;
      return sorted[Math.max(0, index)];
    };

    const count = messagesWithStats.length;
    return {
      count,
      avgClientTTFT: avg(clientTTFTs),
      avgServerTTFT: avg(serverTTFTs),
      avgNetwork: avg(networkOverheads),
      minNetwork: Math.min(...networkOverheads),
      maxNetwork: Math.max(...networkOverheads),
      p99Network: percentile(networkOverheads, 99),
    };
  })();

  return (
    <div className="flex-1 overflow-hidden flex flex-col">
      <div className="flex-1 overflow-y-auto px-4 py-6">
        {messages.length === 0 ? (
          <div className="h-full flex items-center justify-center">
            <div className="text-center max-w-md">
              <div className="w-20 h-20 mx-auto mb-6 rounded-2xl bg-gradient-to-br from-violet-400 to-purple-500 flex items-center justify-center shadow-lg">
                <MessageCircle className="w-10 h-10 text-white" />
              </div>
              <h2 className="text-2xl font-semibold text-slate-800 mb-2">
                AppSync Subscription Chat
              </h2>
              <p className="text-slate-500">
                This mode uses AppSync subscriptions to stream responses.
                Messages are stored in DynamoDB and streamed via GraphQL
                subscriptions.
              </p>
            </div>
          </div>
        ) : (
          <div className="space-y-6">
            {messages.map((message) => (
              <div key={message.id}>
                <div
                  className={`flex gap-3 ${
                    message.role === "user" ? "flex-row-reverse" : ""
                  }`}
                >
                  <div
                    className={`shrink-0 w-8 h-8 rounded-lg flex items-center justify-center text-sm font-medium ${
                      message.role === "user"
                        ? "bg-slate-700 text-white"
                        : "bg-gradient-to-br from-violet-400 to-purple-500 text-white"
                    }`}
                  >
                    {message.role === "user" ? "You" : "C"}
                  </div>
                  <div
                    className={`max-w-[85%] px-4 py-3 rounded-2xl ${
                      message.role === "user"
                        ? "bg-slate-700 text-white rounded-tr-md"
                        : "bg-white text-slate-800 shadow-sm border border-slate-200 rounded-tl-md"
                    }`}
                  >
                    <p className="whitespace-pre-wrap leading-relaxed">
                      {message.content}
                      {message.isStreaming && (
                        <span className="inline-block w-2 h-5 ml-1 bg-violet-400 animate-pulse rounded-sm align-middle" />
                      )}
                    </p>
                  </div>
                </div>
                {message.role === "assistant" &&
                  message.isComplete &&
                  message.ttftMs !== undefined && (
                    <div className="ml-11 mt-1 flex items-center gap-3 text-[10px] text-slate-400">
                      <span>
                        TTFT{" "}
                        <span className="text-slate-500">
                          {message.clientTtftMs}ms
                        </span>
                      </span>
                      <span>
                        Server{" "}
                        <span className="text-slate-500">
                          {message.ttftMs}ms
                        </span>
                      </span>
                      <span>
                        Network{" "}
                        <span className="text-slate-500">
                          +{(message.clientTtftMs ?? 0) - (message.ttftMs ?? 0)}
                          ms
                        </span>
                      </span>
                    </div>
                  )}
              </div>
            ))}
            <div ref={messagesEndRef} />
          </div>
        )}
      </div>

      <div className="shrink-0 border-t border-slate-200 bg-white px-4 py-4">
        {summarizedStats && (
          <div className="mb-3 flex items-center justify-center gap-4 text-xs text-slate-500">
            <span className="text-slate-400">
              {summarizedStats.count} message
              {summarizedStats.count > 1 ? "s" : ""}
            </span>
            <div className="w-px h-3 bg-slate-200" />
            <span>
              Avg TTFT{" "}
              <span className="font-mono text-slate-700">
                {summarizedStats.avgClientTTFT}ms
              </span>
            </span>
            <div className="w-px h-3 bg-slate-200" />
            <span>
              Avg Server{" "}
              <span className="font-mono text-slate-700">
                {summarizedStats.avgServerTTFT}ms
              </span>
            </span>
            <div className="w-px h-3 bg-slate-200" />
            <span>
              Network{" "}
              <span className="font-mono text-slate-700">
                +{summarizedStats.avgNetwork}ms
              </span>
              {summarizedStats.count > 1 && (
                <span className="text-slate-400">
                  {" "}
                  (min {summarizedStats.minNetwork}, max{" "}
                  {summarizedStats.maxNetwork}, p99 {summarizedStats.p99Network}
                  ms)
                </span>
              )}
            </span>
          </div>
        )}
        {sessionId && (
          <div className="mb-3 flex items-center justify-center gap-4 text-xs text-slate-500 hidden">
            <span>Session: {sessionId.slice(0, 8)}...</span>
            <button
              onClick={startNewSession}
              className="text-violet-500 hover:text-violet-700 underline"
            >
              Start New Session
            </button>
          </div>
        )}
        <div className="flex gap-3 items-center">
          <input
            type="text"
            value={userInput}
            onChange={(e) => setUserInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                sendMessage();
              }
            }}
            placeholder="Message Claude..."
            disabled={isStreaming}
            className="flex-1 px-4 py-3 bg-slate-100 border border-slate-200 rounded-xl text-slate-800 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-violet-400 focus:border-transparent disabled:opacity-50 disabled:cursor-not-allowed transition-all"
          />
          {isStreaming ? (
            <button
              onClick={stopStreaming}
              className="shrink-0 w-12 h-12 flex items-center justify-center rounded-xl bg-red-500 hover:bg-red-600 text-white transition-colors"
            >
              <Square className="w-5 h-5" />
            </button>
          ) : (
            <button
              onClick={sendMessage}
              disabled={!userInput.trim()}
              className="shrink-0 w-12 h-12 flex items-center justify-center rounded-xl bg-gradient-to-br from-violet-400 to-purple-500 hover:from-violet-500 hover:to-purple-600 text-white disabled:opacity-50 disabled:cursor-not-allowed transition-all shadow-sm"
            >
              <Send className="w-5 h-5" />
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
