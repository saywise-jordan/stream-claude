import { useEffect, useState, useRef } from "react";
import { Send, Square, MessageCircle, Settings } from "lucide-react";
import { fetchAuthSession } from "aws-amplify/auth";
import outputs from "../../amplify_outputs.json";

interface MessageStats {
  clientTtftMs?: number;
  serverTtftMs?: number;
  completionMs?: number;
}

interface Message {
  id: string;
  role: "user" | "assistant";
  content: string;
  isStreaming?: boolean;
  isComplete?: boolean;
  stats?: MessageStats;
}

const DEFAULT_ECS_URL = outputs.custom?.ecsChatUrl || "http://localhost:3000";

export function EcsCompareChat() {
  const [messages, setMessages] = useState<Message[]>([]);
  const [userInput, setUserInput] = useState<string>("");
  const [isStreaming, setIsStreaming] = useState<boolean>(false);
  const [simulate, setSimulate] = useState<boolean>(true);
  const [ecsUrl, setEcsUrl] = useState<string>(() => {
    return localStorage.getItem("ecsUrl") || DEFAULT_ECS_URL;
  });
  const [showSettings, setShowSettings] = useState<boolean>(false);
  const [tempUrl, setTempUrl] = useState<string>(ecsUrl);
  const messagesEndRef = useRef<HTMLDivElement | null>(null);

  const abortControllerRef = useRef<AbortController | null>(null);
  const startTimeRef = useRef<number>(0);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  useEffect(() => {
    return () => {
      abortControllerRef.current?.abort();
    };
  }, []);

  function saveUrl() {
    setEcsUrl(tempUrl);
    localStorage.setItem("ecsUrl", tempUrl);
    setShowSettings(false);
  }

  async function sendMessage() {
    if (!userInput.trim() || isStreaming) return;

    const messageToSend = userInput;
    setUserInput("");
    setIsStreaming(true);

    const userMessage: Message = {
      id: crypto.randomUUID(),
      role: "user",
      content: messageToSend,
    };

    const assistantMessage: Message = {
      id: crypto.randomUUID(),
      role: "assistant",
      content: "",
      isStreaming: true,
      isComplete: false,
    };

    setMessages((prev) => [...prev, userMessage, assistantMessage]);

    const allMessages = messages
      .filter((m) => m.role === "user" || m.isComplete)
      .map(({ role, content }) => ({ role, content }));

    const messagesForApi = [
      ...allMessages,
      { role: "user" as const, content: messageToSend },
    ];

    await streamFromSse(assistantMessage.id, messagesForApi);
    setIsStreaming(false);
  }

  async function streamFromSse(
    messageId: string,
    apiMessages: { role: "user" | "assistant"; content: string }[]
  ) {
    const sseUrl = `${ecsUrl}/chat`;
    abortControllerRef.current = new AbortController();
    startTimeRef.current = Date.now();

    try {
      const session = await fetchAuthSession();
      const accessToken = session.tokens?.accessToken?.toString();

      const headers: Record<string, string> = { "Content-Type": "application/json" };
      if (accessToken) {
        headers["Authorization"] = `Bearer ${accessToken}`;
      }

      const response = await fetch(sseUrl, {
        method: "POST",
        headers,
        body: JSON.stringify({ messages: apiMessages, simulate }),
        signal: abortControllerRef.current.signal,
      });

      if (!response.body) return;

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let fullMessage = "";
      let buffer = "";
      let clientTtftMs = 0;
      let serverTtftMs = 0;

      // eslint-disable-next-line no-constant-condition
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";

        let currentEvent: { type?: string; data?: string } = {};

        for (const line of lines) {
          if (line.trim() === "") {
            if (currentEvent.type === "stats" && currentEvent.data) {
              try {
                const eventData = JSON.parse(currentEvent.data);
                serverTtftMs = eventData.stats?.ttftMs || 0;
              } catch (e) {
                console.error("Failed to parse stats:", e);
              }
            } else if (currentEvent.data) {
              try {
                const eventData = JSON.parse(currentEvent.data);
                if (
                  eventData.type === "content_block_delta" &&
                  eventData.delta?.type === "text_delta"
                ) {
                  if (clientTtftMs === 0) {
                    clientTtftMs = Date.now() - startTimeRef.current;
                  }
                  fullMessage += eventData.delta.text;
                  setMessages((prev) =>
                    prev.map((m) =>
                      m.id === messageId ? { ...m, content: fullMessage } : m
                    )
                  );
                }
              } catch (e) {
                console.error("Failed to parse event:", e);
              }
            }
            currentEvent = {};
          } else if (line.startsWith("event:")) {
            currentEvent.type = line.substring(6).trim();
          } else if (line.startsWith("data:")) {
            currentEvent.data = line.substring(5).trim();
          }
        }
      }

      const completionMs = Date.now() - startTimeRef.current;
      setMessages((prev) =>
        prev.map((m) =>
          m.id === messageId
            ? {
                ...m,
                content: fullMessage,
                isStreaming: false,
                isComplete: true,
                stats: { clientTtftMs, serverTtftMs, completionMs },
              }
            : m
        )
      );
    } catch (error) {
      if (error instanceof Error && error.name !== "AbortError") {
        console.error("SSE stream error:", error);
        setMessages((prev) =>
          prev.map((m) =>
            m.id === messageId
              ? {
                  ...m,
                  content: `Error: ${error.message}`,
                  isStreaming: false,
                  isComplete: true,
                }
              : m
          )
        );
      }
    }
  }

  function stopStreaming() {
    abortControllerRef.current?.abort();
    setIsStreaming(false);
  }

  const summarizedStats = (() => {
    const completed = messages.filter((m) => m.role === "assistant" && m.isComplete && m.stats);
    if (completed.length === 0) return null;

    const ttfts = completed.map((m) => m.stats?.clientTtftMs || 0);
    const completions = completed.map((m) => m.stats?.completionMs || 0);

    const avg = (arr: number[]) => Math.round(arr.reduce((a, b) => a + b, 0) / arr.length);

    return {
      count: completed.length,
      avgTtft: avg(ttfts),
      avgCompletion: avg(completions),
    };
  })();

  return (
    <div className="flex-1 overflow-hidden flex flex-col">
      <div className="flex-1 overflow-y-auto px-4 py-6">
        {messages.length === 0 ? (
          <div className="h-full flex items-center justify-center">
            <div className="text-center max-w-md">
              <div className="w-20 h-20 mx-auto mb-6 rounded-2xl bg-gradient-to-br from-rose-400 to-pink-500 flex items-center justify-center shadow-lg">
                <MessageCircle className="w-10 h-10 text-white" />
              </div>
              <h2 className="text-2xl font-semibold text-slate-800 mb-2">
                ECS Chat
              </h2>
              <p className="text-slate-500">
                Send a message to chat via the ECS SSE backend.
              </p>
              <p className="text-xs text-slate-400 mt-3">
                Server: {ecsUrl}
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
                        : "bg-gradient-to-br from-rose-400 to-pink-500 text-white"
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
                      {message.content || (
                        <span className="text-slate-400">Waiting...</span>
                      )}
                      {message.isStreaming && message.content && (
                        <span className="inline-block w-2 h-4 ml-1 bg-rose-400 animate-pulse rounded-sm align-middle" />
                      )}
                    </p>
                  </div>
                </div>
                {message.role === "assistant" && message.isComplete && message.stats && (
                  <div className="ml-11 mt-1 flex items-center gap-3 text-[10px] text-slate-400">
                    <span>
                      TTFT{" "}
                      <span className="text-slate-500">
                        {message.stats.clientTtftMs}ms
                      </span>
                    </span>
                    {simulate && message.stats.completionMs && (
                      <span>
                        Done{" "}
                        <span className="text-slate-500">
                          {message.stats.completionMs}ms
                        </span>
                      </span>
                    )}
                  </div>
                )}
              </div>
            ))}
            <div ref={messagesEndRef} />
          </div>
        )}
      </div>

      <div className="shrink-0 border-t border-slate-200 bg-white px-4 py-4">
        {showSettings && (
          <div className="mb-3 p-3 bg-slate-50 rounded-lg border border-slate-200">
            <label className="block text-xs font-medium text-slate-600 mb-1">
              ECS Server URL
            </label>
            <div className="flex gap-2">
              <input
                type="text"
                value={tempUrl}
                onChange={(e) => setTempUrl(e.target.value)}
                placeholder="http://localhost:3000"
                className="flex-1 px-3 py-2 text-sm bg-white border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-rose-400"
              />
              <button
                onClick={saveUrl}
                className="px-3 py-2 text-sm font-medium text-white bg-rose-500 hover:bg-rose-600 rounded-lg transition-colors"
              >
                Save
              </button>
              <button
                onClick={() => {
                  setTempUrl(ecsUrl);
                  setShowSettings(false);
                }}
                className="px-3 py-2 text-sm font-medium text-slate-600 hover:bg-slate-200 rounded-lg transition-colors"
              >
                Cancel
              </button>
            </div>
          </div>
        )}
        {summarizedStats && (
          <div className="mb-3 flex items-center justify-center gap-4 text-xs text-slate-500">
            <span className="text-slate-400">
              {summarizedStats.count} message
              {summarizedStats.count > 1 ? "s" : ""}
            </span>
            <div className="w-px h-3 bg-slate-200" />
            <span>
              Avg TTFT{" "}
              <span className="font-mono text-rose-600">
                {summarizedStats.avgTtft}ms
              </span>
            </span>
            {simulate && (
              <>
                <div className="w-px h-3 bg-slate-200" />
                <span>
                  Avg completion{" "}
                  <span className="font-mono text-rose-600">
                    {summarizedStats.avgCompletion}ms
                  </span>
                </span>
              </>
            )}
          </div>
        )}
        <div className="flex gap-3 items-center">
          <button
            onClick={() => setShowSettings(!showSettings)}
            disabled={isStreaming}
            className={`shrink-0 w-10 h-10 flex items-center justify-center rounded-lg transition-colors ${
              showSettings
                ? "bg-rose-100 text-rose-600"
                : "text-slate-400 hover:bg-slate-100"
            } disabled:opacity-50`}
          >
            <Settings className="w-5 h-5" />
          </button>
          <label className="flex items-center gap-2 text-sm text-slate-600 cursor-pointer select-none">
            <input
              type="checkbox"
              checked={simulate}
              onChange={(e) => setSimulate(e.target.checked)}
              disabled={isStreaming}
              className="w-4 h-4 rounded border-slate-300 text-rose-500 focus:ring-rose-400 disabled:opacity-50"
            />
            Simulate
          </label>
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
            placeholder={simulate ? "Message (simulated response)..." : "Message Claude (ECS)..."}
            disabled={isStreaming}
            className="flex-1 px-4 py-3 bg-slate-100 border border-slate-200 rounded-xl text-slate-800 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-rose-400 focus:border-transparent disabled:opacity-50 disabled:cursor-not-allowed transition-all"
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
              className="shrink-0 w-12 h-12 flex items-center justify-center rounded-xl bg-gradient-to-br from-rose-400 to-pink-500 hover:from-rose-500 hover:to-pink-600 text-white disabled:opacity-50 disabled:cursor-not-allowed transition-all shadow-sm"
            >
              <Send className="w-5 h-5" />
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
