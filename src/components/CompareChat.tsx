import { useEffect, useState, useRef } from "react";
import { generateClient } from "aws-amplify/data";
import { fetchAuthSession } from "aws-amplify/auth";
import type { Schema } from "../../amplify/data/resource";
import { Send, Square, MessageCircle } from "lucide-react";
import { Amplify } from "aws-amplify";
import amplifyOutputs from "../../amplify_outputs.json";
import { SignatureV4 } from "@aws-sdk/signature-v4";
import { HttpRequest } from "@smithy/protocol-http";
import { Sha256 } from "@aws-crypto/sha256-js";

Amplify.configure(amplifyOutputs);

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
}

interface CompareMessage {
  id: string;
  userContent: string;
  lambda: Message & { stats?: MessageStats };
  appsync: Message & { stats?: MessageStats };
}

const client = generateClient<Schema>({
  authMode: "userPool",
});

export function CompareChat() {
  const [compareMessages, setCompareMessages] = useState<CompareMessage[]>([]);
  const [userInput, setUserInput] = useState<string>("");
  const [isStreaming, setIsStreaming] = useState<boolean>(false);
  const messagesEndRef = useRef<HTMLDivElement | null>(null);

  const abortControllerRef = useRef<AbortController | null>(null);
  const updateSubRef = useRef<{ unsubscribe: () => void } | null>(null);
  const lambdaStartRef = useRef<number>(0);
  const appsyncStartRef = useRef<number>(0);
  const appsyncFirstUpdateRef = useRef<boolean>(false);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [compareMessages]);

  useEffect(() => {
    return () => {
      abortControllerRef.current?.abort();
      updateSubRef.current?.unsubscribe();
    };
  }, []);

  async function signRequest(url: string, body: string) {
    const session = await fetchAuthSession();
    const credentials = session.credentials;

    if (!credentials) {
      throw new Error("No credentials available");
    }

    const parsedUrl = new URL(url);
    const request = new HttpRequest({
      method: "POST",
      protocol: parsedUrl.protocol,
      hostname: parsedUrl.hostname,
      path: parsedUrl.pathname,
      headers: {
        "Content-Type": "application/json",
        host: parsedUrl.hostname,
      },
      body,
    });

    const signer = new SignatureV4({
      credentials,
      region: amplifyOutputs.auth?.aws_region || "us-east-1",
      service: "lambda",
      sha256: Sha256,
    });

    const signedRequest = await signer.sign(request);
    return signedRequest;
  }

  async function sendMessage() {
    if (!userInput.trim() || isStreaming) return;

    const messageToSend = userInput;
    setUserInput("");
    setIsStreaming(true);

    const compareId = crypto.randomUUID();
    const lambdaId = `lambda-${compareId}`;
    const appsyncId = crypto.randomUUID();

    const allMessages = compareMessages.flatMap((cm) => [
      { role: "user" as const, content: cm.userContent },
      { role: "assistant" as const, content: cm.lambda.content },
    ]);

    const newCompareMessage: CompareMessage = {
      id: compareId,
      userContent: messageToSend,
      lambda: {
        id: lambdaId,
        role: "assistant",
        content: "",
        isStreaming: true,
        isComplete: false,
      },
      appsync: {
        id: appsyncId,
        role: "assistant",
        content: "Thinking...",
        isStreaming: true,
        isComplete: false,
      },
    };

    setCompareMessages((prev) => [...prev, newCompareMessage]);

    lambdaStartRef.current = Date.now();
    appsyncStartRef.current = Date.now();
    appsyncFirstUpdateRef.current = false;

    const messagesForApi = [
      ...allMessages,
      { role: "user" as const, content: messageToSend },
    ];

    await Promise.all([
      streamFromLambda(compareId, messagesForApi),
      streamFromAppSync(compareId, appsyncId, messagesForApi),
    ]);
  }

  async function streamFromLambda(
    compareId: string,
    messages: { role: "user" | "assistant"; content: string }[]
  ) {
    const chatUrl = amplifyOutputs.custom?.chatUrl;
    if (!chatUrl) return;

    abortControllerRef.current = new AbortController();

    try {
      const body = JSON.stringify({ messages });
      const signedRequest = await signRequest(chatUrl, body);

      const response = await fetch(chatUrl, {
        method: signedRequest.method,
        headers: signedRequest.headers,
        body: signedRequest.body,
        signal: abortControllerRef.current.signal,
      });

      if (!response.body) return;

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let fullMessage = "";
      let buffer = "";
      let clientTtftMs = 0;
      let serverTtftMs = 0;

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
                serverTtftMs = eventData.stats?.firstTokenMs || 0;
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
                    clientTtftMs = Date.now() - lambdaStartRef.current;
                  }
                  fullMessage += eventData.delta.text;
                  setCompareMessages((prev) =>
                    prev.map((cm) =>
                      cm.id === compareId
                        ? { ...cm, lambda: { ...cm.lambda, content: fullMessage } }
                        : cm
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

      const completionMs = Date.now() - lambdaStartRef.current;
      setCompareMessages((prev) =>
        prev.map((cm) =>
          cm.id === compareId
            ? {
                ...cm,
                lambda: {
                  ...cm.lambda,
                  content: fullMessage,
                  isStreaming: false,
                  isComplete: true,
                  stats: { clientTtftMs, serverTtftMs, completionMs },
                },
              }
            : cm
        )
      );
    } catch (error) {
      if (error instanceof Error && error.name !== "AbortError") {
        console.error("Lambda stream error:", error);
      }
    }
  }

  async function streamFromAppSync(
    compareId: string,
    messageId: string,
    messages: { role: "user" | "assistant"; content: string }[]
  ) {
    updateSubRef.current?.unsubscribe();

    const updateSub = client.models.ChatMessage.onUpdate({
      filter: { id: { eq: messageId } },
    }).subscribe({
      next: (updatedMessage) => {
        if (!updatedMessage) return;

        let clientTtftMs: number | undefined;
        const hasContent =
          updatedMessage.content && updatedMessage.content !== "Thinking...";
        if (!appsyncFirstUpdateRef.current && hasContent) {
          appsyncFirstUpdateRef.current = true;
          clientTtftMs = Date.now() - appsyncStartRef.current;
        }

        setCompareMessages((prev) =>
          prev.map((cm) =>
            cm.id === compareId
              ? {
                  ...cm,
                  appsync: {
                    ...cm.appsync,
                    content: updatedMessage.content,
                    isStreaming: updatedMessage.isStreaming || false,
                    isComplete: updatedMessage.isComplete || false,
                    stats: {
                      clientTtftMs: clientTtftMs ?? cm.appsync.stats?.clientTtftMs,
                      serverTtftMs: updatedMessage.ttftMs ?? cm.appsync.stats?.serverTtftMs,
                      completionMs:
                        updatedMessage.completionMs ?? cm.appsync.stats?.completionMs,
                    },
                  },
                }
              : cm
          )
        );

        if (updatedMessage.isComplete) {
          checkStreamingComplete();
          updateSubRef.current?.unsubscribe();
          updateSubRef.current = null;
        }
      },
      error: (error) => {
        console.error("AppSync subscription error:", error);
        checkStreamingComplete();
      },
    });

    updateSubRef.current = updateSub;

    try {
      await client.mutations.chat({
        sessionId: crypto.randomUUID(),
        messageId: messageId,
        messages: messages.map((m) => ({
          role: m.role,
          content: m.content,
        })),
      });
    } catch (error) {
      console.error("AppSync mutation error:", error);
    }
  }

  function checkStreamingComplete() {
    setCompareMessages((prev) => {
      const lastMessage = prev[prev.length - 1];
      if (lastMessage?.lambda.isComplete && lastMessage?.appsync.isComplete) {
        setIsStreaming(false);
      }
      return prev;
    });
  }

  function stopStreaming() {
    abortControllerRef.current?.abort();
    updateSubRef.current?.unsubscribe();
    setIsStreaming(false);
  }

  const summarizedStats = (() => {
    const completed = compareMessages.filter(
      (cm) => cm.lambda.isComplete && cm.appsync.isComplete
    );
    if (completed.length === 0) return null;

    const lambdaTtfts = completed.map((cm) => cm.lambda.stats?.clientTtftMs || 0);
    const appsyncTtfts = completed.map((cm) => cm.appsync.stats?.clientTtftMs || 0);

    const avg = (arr: number[]) => Math.round(arr.reduce((a, b) => a + b, 0) / arr.length);

    return {
      count: completed.length,
      lambdaAvgTtft: avg(lambdaTtfts),
      appsyncAvgTtft: avg(appsyncTtfts),
      difference: avg(appsyncTtfts) - avg(lambdaTtfts),
    };
  })();

  return (
    <div className="flex-1 overflow-hidden flex flex-col">
      <div className="flex-1 overflow-y-auto px-4 py-6">
        {compareMessages.length === 0 ? (
          <div className="h-full flex items-center justify-center">
            <div className="text-center max-w-md">
              <div className="w-20 h-20 mx-auto mb-6 rounded-2xl bg-gradient-to-br from-emerald-400 to-teal-500 flex items-center justify-center shadow-lg">
                <MessageCircle className="w-10 h-10 text-white" />
              </div>
              <h2 className="text-2xl font-semibold text-slate-800 mb-2">
                Compare Mode
              </h2>
              <p className="text-slate-500">
                Send a message to both Lambda Stream and AppSync Subscription
                simultaneously and compare the streaming performance.
              </p>
            </div>
          </div>
        ) : (
          <div className="space-y-8">
            {compareMessages.map((cm) => (
              <div key={cm.id} className="space-y-4">
                <div className="flex gap-3 flex-row-reverse">
                  <div className="shrink-0 w-8 h-8 rounded-lg bg-slate-700 flex items-center justify-center text-sm font-medium text-white">
                    You
                  </div>
                  <div className="max-w-[85%] px-4 py-3 rounded-2xl bg-slate-700 text-white rounded-tr-md">
                    <p className="whitespace-pre-wrap leading-relaxed">
                      {cm.userContent}
                    </p>
                  </div>
                </div>

                <div className="grid grid-cols-2 gap-4">
                  <div className="space-y-2">
                    <div className="text-xs font-medium text-orange-600 flex items-center gap-1">
                      Lambda Stream
                      {cm.lambda.isComplete && cm.lambda.stats && (
                        <span className="text-slate-400 font-normal ml-2">
                          TTFT: {cm.lambda.stats.clientTtftMs}ms
                        </span>
                      )}
                    </div>
                    <div className="px-4 py-3 rounded-2xl bg-white text-slate-800 shadow-sm border border-orange-200 rounded-tl-md min-h-[60px]">
                      <p className="whitespace-pre-wrap leading-relaxed text-sm">
                        {cm.lambda.content || (
                          <span className="text-slate-400">Waiting...</span>
                        )}
                        {cm.lambda.isStreaming && cm.lambda.content && (
                          <span className="inline-block w-2 h-4 ml-1 bg-orange-400 animate-pulse rounded-sm align-middle" />
                        )}
                      </p>
                    </div>
                  </div>

                  <div className="space-y-2">
                    <div className="text-xs font-medium text-violet-600 flex items-center gap-1">
                      AppSync Subscription
                      {cm.appsync.isComplete && cm.appsync.stats && (
                        <span className="text-slate-400 font-normal ml-2">
                          TTFT: {cm.appsync.stats.clientTtftMs}ms
                        </span>
                      )}
                    </div>
                    <div className="px-4 py-3 rounded-2xl bg-white text-slate-800 shadow-sm border border-violet-200 rounded-tl-md min-h-[60px]">
                      <p className="whitespace-pre-wrap leading-relaxed text-sm">
                        {cm.appsync.content}
                        {cm.appsync.isStreaming &&
                          cm.appsync.content !== "Thinking..." && (
                            <span className="inline-block w-2 h-4 ml-1 bg-violet-400 animate-pulse rounded-sm align-middle" />
                          )}
                      </p>
                    </div>
                  </div>
                </div>

                {cm.lambda.isComplete && cm.appsync.isComplete && (
                  <div className="flex justify-center gap-6 text-xs text-slate-500">
                    <span>
                      Lambda:{" "}
                      <span className="font-mono text-orange-600">
                        {cm.lambda.stats?.clientTtftMs}ms
                      </span>
                    </span>
                    <span>
                      AppSync:{" "}
                      <span className="font-mono text-violet-600">
                        {cm.appsync.stats?.clientTtftMs}ms
                      </span>
                    </span>
                    <span>
                      Diff:{" "}
                      <span
                        className={`font-mono ${
                          (cm.appsync.stats?.clientTtftMs || 0) -
                            (cm.lambda.stats?.clientTtftMs || 0) >
                          0
                            ? "text-red-500"
                            : "text-green-500"
                        }`}
                      >
                        {(cm.appsync.stats?.clientTtftMs || 0) -
                          (cm.lambda.stats?.clientTtftMs || 0) >
                        0
                          ? "+"
                          : ""}
                        {(cm.appsync.stats?.clientTtftMs || 0) -
                          (cm.lambda.stats?.clientTtftMs || 0)}
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
              {summarizedStats.count} comparison
              {summarizedStats.count > 1 ? "s" : ""}
            </span>
            <div className="w-px h-3 bg-slate-200" />
            <span>
              Lambda Avg{" "}
              <span className="font-mono text-orange-600">
                {summarizedStats.lambdaAvgTtft}ms
              </span>
            </span>
            <div className="w-px h-3 bg-slate-200" />
            <span>
              AppSync Avg{" "}
              <span className="font-mono text-violet-600">
                {summarizedStats.appsyncAvgTtft}ms
              </span>
            </span>
            <div className="w-px h-3 bg-slate-200" />
            <span>
              Diff{" "}
              <span
                className={`font-mono ${
                  summarizedStats.difference > 0 ? "text-red-500" : "text-green-500"
                }`}
              >
                {summarizedStats.difference > 0 ? "+" : ""}
                {summarizedStats.difference}ms
              </span>
            </span>
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
            placeholder="Message Claude (comparing both backends)..."
            disabled={isStreaming}
            className="flex-1 px-4 py-3 bg-slate-100 border border-slate-200 rounded-xl text-slate-800 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-emerald-400 focus:border-transparent disabled:opacity-50 disabled:cursor-not-allowed transition-all"
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
              className="shrink-0 w-12 h-12 flex items-center justify-center rounded-xl bg-gradient-to-br from-emerald-400 to-teal-500 hover:from-emerald-500 hover:to-teal-600 text-white disabled:opacity-50 disabled:cursor-not-allowed transition-all shadow-sm"
            >
              <Send className="w-5 h-5" />
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
