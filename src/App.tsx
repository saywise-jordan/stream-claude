import { useEffect, useState, useRef } from "react";
import { Amplify } from "aws-amplify";
import { signOut, getCurrentUser, fetchAuthSession } from "aws-amplify/auth";
import { Authenticator } from "@aws-amplify/ui-react";
import "@aws-amplify/ui-react/styles.css";
import amplifyOutputs from "../amplify_outputs.json";
import { Send, Square, LogOut, MessageCircle } from "lucide-react";
import { SignatureV4 } from "@aws-sdk/signature-v4";
import { HttpRequest } from "@smithy/protocol-http";
import { Sha256 } from "@aws-crypto/sha256-js";

Amplify.configure(amplifyOutputs);

interface Message {
  role: "user" | "assistant";
  content: string;
}

function App() {
  const [messages, setMessages] = useState<Message[]>([]);
  const [userInput, setUserInput] = useState<string>("");
  const [isStreaming, setIsStreaming] = useState<boolean>(false);
  const [streamingMessage, setStreamingMessage] = useState<string>("");
  const [userEmail, setUserEmail] = useState<string>("");
  const abortControllerRef = useRef<AbortController | null>(null);
  const messagesEndRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    getCurrentUser().then((user) => {
      setUserEmail(user.signInDetails?.loginId || "");
    });
  }, []);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, streamingMessage]);

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

  async function chat() {
    if (!userInput.trim() || isStreaming) return;

    const chatUrl = amplifyOutputs.custom?.chatUrl;
    if (!chatUrl) {
      setStreamingMessage(
        "Error: Function URL not found in amplify_outputs.json"
      );
      return;
    }

    const messageToSend = userInput;
    setUserInput("");

    const newUserMessage: Message = {
      role: "user",
      content: messageToSend,
    };

    const updatedMessages = [...messages, newUserMessage];
    setMessages(updatedMessages);

    setIsStreaming(true);
    setStreamingMessage("");

    abortControllerRef.current = new AbortController();

    try {
      const body = JSON.stringify({ messages: updatedMessages });
      const signedRequest = await signRequest(chatUrl, body);

      const start = new Date();
      const response = await fetch(chatUrl, {
        method: signedRequest.method,
        headers: signedRequest.headers,
        body: signedRequest.body,
        signal: abortControllerRef.current.signal,
      });

      if (!response.body) {
        throw new Error("No response body");
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let fullMessage = "";
      let buffer = "";
      const clientStats: { firstTokenMs: number; endMs: number } = {
        firstTokenMs: 0,
        endMs: 0,
      };
      let serverStats: { firstTokenMs: number; endMs: number } = {
        firstTokenMs: 0,
        endMs: 0,
      };

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
            if (currentEvent.type === "message_stop") {
              clientStats.endMs = new Date().getTime() - start.getTime();
            } else if (currentEvent.type === "stats" && currentEvent.data) {
              try {
                const eventData = JSON.parse(currentEvent.data);
                serverStats = eventData["stats"];
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
                  if (clientStats.firstTokenMs === 0) {
                    clientStats.firstTokenMs =
                      new Date().getTime() - start.getTime();
                  }
                  fullMessage += eventData.delta.text;
                  setStreamingMessage(fullMessage);
                }
              } catch (e) {
                console.error("Failed to parse event data:", e);
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

      if (fullMessage) {
        const assistantMessage: Message = {
          role: "assistant",
          content: fullMessage,
        };
        setMessages([...updatedMessages, assistantMessage]);
      }

      console.log("Client Stats", clientStats);
      console.log("Server Stats", serverStats);
      console.log("Delta", {
        firstTokenMs: clientStats.firstTokenMs - serverStats.firstTokenMs,
        endMs: clientStats.endMs - serverStats.endMs,
      });
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") {
        if (streamingMessage) {
          const assistantMessage: Message = {
            role: "assistant",
            content: streamingMessage,
          };
          setMessages([...updatedMessages, assistantMessage]);
        }
      } else {
        setStreamingMessage(
          `Error: ${error instanceof Error ? error.message : String(error)}`
        );
      }
    } finally {
      setIsStreaming(false);
      setStreamingMessage("");
      abortControllerRef.current = null;
    }
  }

  function stopStreaming() {
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
    }
  }

  const handleKeyPress = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      chat();
    }
  };

  async function handleSignOut() {
    try {
      await signOut();
    } catch (error) {
      console.error("Error signing out:", error);
    }
  }

  return (
    <div className="flex flex-col h-screen bg-slate-50">
      <header className="shrink-0 border-b border-slate-200 bg-white">
        <div className="max-w-3xl mx-auto px-4 py-3 flex justify-between items-center">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-orange-400 to-amber-500 flex items-center justify-center shadow-sm">
              <MessageCircle className="w-5 h-5 text-white" />
            </div>
            <div>
              <h1 className="text-lg font-semibold text-slate-800">
                Stream Claude
              </h1>
              {userEmail && (
                <p className="text-xs text-slate-400">{userEmail}</p>
              )}
            </div>
          </div>
          <button
            onClick={handleSignOut}
            className="flex items-center gap-2 px-3 py-2 text-sm text-slate-600 hover:text-slate-800 hover:bg-slate-100 rounded-lg transition-colors"
          >
            <LogOut className="w-4 h-4" />
            <span className="hidden sm:inline">Sign Out</span>
          </button>
        </div>
      </header>

      <main className="flex-1 overflow-hidden max-w-3xl w-full mx-auto flex flex-col">
        <div className="flex-1 overflow-y-auto px-4 py-6">
          {messages.length === 0 && !streamingMessage ? (
            <div className="h-full flex items-center justify-center">
              <div className="text-center max-w-md">
                <div className="w-20 h-20 mx-auto mb-6 rounded-2xl bg-gradient-to-br from-orange-400 to-amber-500 flex items-center justify-center shadow-lg">
                  <MessageCircle className="w-10 h-10 text-white" />
                </div>
                <h2 className="text-2xl font-semibold text-slate-800 mb-2">
                  How can I help you today?
                </h2>
                <p className="text-slate-500">
                  Start a conversation with Claude. Ask questions, get help with
                  writing, or explore ideas together.
                </p>
              </div>
            </div>
          ) : (
            <div className="space-y-6">
              {messages.map((message, index) => (
                <div
                  key={index}
                  className={`flex gap-3 ${message.role === "user" ? "flex-row-reverse" : ""}`}
                >
                  <div
                    className={`shrink-0 w-8 h-8 rounded-lg flex items-center justify-center text-sm font-medium ${
                      message.role === "user"
                        ? "bg-slate-700 text-white"
                        : "bg-gradient-to-br from-orange-400 to-amber-500 text-white"
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
                    </p>
                  </div>
                </div>
              ))}
              {streamingMessage && (
                <div className="flex gap-3">
                  <div className="shrink-0 w-8 h-8 rounded-lg bg-gradient-to-br from-orange-400 to-amber-500 flex items-center justify-center text-sm font-medium text-white">
                    C
                  </div>
                  <div className="max-w-[85%] px-4 py-3 rounded-2xl rounded-tl-md bg-white text-slate-800 shadow-sm border border-slate-200">
                    <p className="whitespace-pre-wrap leading-relaxed">
                      {streamingMessage}
                      <span className="inline-block w-2 h-5 ml-1 bg-orange-400 animate-pulse rounded-sm align-middle" />
                    </p>
                  </div>
                </div>
              )}
              <div ref={messagesEndRef} />
            </div>
          )}
        </div>

        <div className="shrink-0 border-t border-slate-200 bg-white px-4 py-4">
          <div className="flex gap-3 items-center">
            <input
              type="text"
              value={userInput}
              onChange={(e) => setUserInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  chat();
                }
              }}
              placeholder="Message Claude..."
              disabled={isStreaming}
              className="flex-1 px-4 py-3 bg-slate-100 border border-slate-200 rounded-xl text-slate-800 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-orange-400 focus:border-transparent disabled:opacity-50 disabled:cursor-not-allowed transition-all"
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
                onClick={chat}
                disabled={!userInput.trim()}
                className="shrink-0 w-12 h-12 flex items-center justify-center rounded-xl bg-gradient-to-br from-orange-400 to-amber-500 hover:from-orange-500 hover:to-amber-600 text-white disabled:opacity-50 disabled:cursor-not-allowed transition-all shadow-sm"
              >
                <Send className="w-5 h-5" />
              </button>
            )}
          </div>
        </div>
      </main>
    </div>
  );
}

export default function AuthenticatedApp() {
  return <Authenticator>{() => <App />}</Authenticator>;
}
