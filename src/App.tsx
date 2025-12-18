import { useEffect, useState, useRef } from "react";
import type { Schema } from "../amplify/data/resource";
import { generateClient } from "aws-amplify/data";
import { Amplify } from "aws-amplify";
import { signOut, getCurrentUser, fetchAuthSession } from "aws-amplify/auth";
import { Authenticator } from "@aws-amplify/ui-react";
import "@aws-amplify/ui-react/styles.css";
import amplifyOutputs from "../amplify_outputs.json";
import { Button, Input, Card, CardBody } from "@heroui/react";
import { Send, Square, LogOut } from "lucide-react";
import { SignatureV4 } from "@aws-sdk/signature-v4";
import { HttpRequest } from "@smithy/protocol-http";
import { Sha256 } from "@aws-crypto/sha256-js";

Amplify.configure(amplifyOutputs);

const client = generateClient<Schema>();

interface Message {
  role: "user" | "assistant";
  content: string;
}

function App() {
  const [todos, setTodos] = useState<Array<Schema["Todo"]["type"]>>([]);
  const [messages, setMessages] = useState<Message[]>([]);
  const [userInput, setUserInput] = useState<string>("");
  const [isStreaming, setIsStreaming] = useState<boolean>(false);
  const [streamingMessage, setStreamingMessage] = useState<string>("");
  const [userEmail, setUserEmail] = useState<string>("");
  const abortControllerRef = useRef<AbortController | null>(null);

  useEffect(() => {
    getCurrentUser().then((user) => {
      setUserEmail(user.signInDetails?.loginId || "");
    });
  }, []);

  useEffect(() => {
    client.models.Todo.observeQuery().subscribe({
      next: (data) => setTodos([...data.items]),
    });
  }, []);

  function createTodo() {
    client.models.Todo.create({ content: window.prompt("Todo content") });
  }

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
      let firstToken: Date | null = null;
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
      let firstTokenMs = 0;
      let endMs = 0;
      let stats = {};

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
            if (currentEvent.data) {
              try {
                const eventData = JSON.parse(currentEvent.data);

                if (
                  eventData.type === "content_block_delta" &&
                  eventData.delta?.type === "text_delta"
                ) {
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
      const clientStats = {
        firstTokenMs,
        endMs,
      };
      console.log("Client Stats", clientStats);
      console.log("Server Stats", stats);
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
    <main className="min-h-screen p-8 max-w-4xl mx-auto">
      <div className="mb-8 flex justify-between items-center">
        <div>
          <h1 className="text-3xl font-bold">Stream Claude</h1>
          {userEmail && (
            <p className="text-sm text-gray-600 mt-1">{userEmail}</p>
          )}
        </div>
        <Button
          onClick={handleSignOut}
          color="default"
          variant="bordered"
          startContent={<LogOut className="h-4 w-4" />}
        >
          Sign Out
        </Button>
      </div>

      <div className="mb-8">
        <h2 className="text-2xl font-bold mb-4">My todos</h2>
        <Button onClick={createTodo} color="primary">
          + new
        </Button>
        <ul className="mt-4 space-y-2">
          {todos.map((todo) => (
            <li key={todo.id} className="p-2 bg-gray-100 rounded">
              {todo.content}
            </li>
          ))}
        </ul>
      </div>

      <div className="mt-8">
        <h2 className="text-2xl font-bold mb-4">Chat with Claude</h2>

        <Card className="mb-4">
          <CardBody>
            <div className="min-h-[200px] max-h-[500px] overflow-y-auto space-y-4">
              {messages.length === 0 && !streamingMessage && (
                <p className="text-gray-500">
                  Type a message to start chatting...
                </p>
              )}
              {messages.map((message, index) => (
                <div
                  key={index}
                  className={`p-3 rounded-lg ${
                    message.role === "user"
                      ? "bg-blue-100 ml-8"
                      : "bg-gray-100 mr-8"
                  }`}
                >
                  <p className="font-semibold text-sm mb-1">
                    {message.role === "user" ? "You" : "Claude"}
                  </p>
                  <p className="whitespace-pre-wrap">{message.content}</p>
                </div>
              ))}
              {streamingMessage && (
                <div className="p-3 rounded-lg bg-gray-100 mr-8">
                  <p className="font-semibold text-sm mb-1">Claude</p>
                  <p className="whitespace-pre-wrap">{streamingMessage}</p>
                </div>
              )}
            </div>
          </CardBody>
        </Card>

        <div className="flex gap-2">
          <Input
            value={userInput}
            onChange={(e) => setUserInput(e.target.value)}
            onKeyPress={handleKeyPress}
            placeholder="Type your message..."
            disabled={isStreaming}
            className="flex-1"
            size="lg"
          />
          {isStreaming ? (
            <Button onClick={stopStreaming} color="danger" isIconOnly size="lg">
              <Square className="h-5 w-5" />
            </Button>
          ) : (
            <Button
              onClick={chat}
              disabled={!userInput.trim()}
              color="primary"
              isIconOnly
              size="lg"
            >
              <Send className="h-5 w-5" />
            </Button>
          )}
        </div>
        {isStreaming && (
          <p className="text-sm text-gray-500 mt-2">Claude is typing...</p>
        )}
      </div>
    </main>
  );
}

export default function AuthenticatedApp() {
  return <Authenticator>{() => <App />}</Authenticator>;
}
