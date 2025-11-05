import { useEffect, useState } from "react";
import type { Schema } from "../amplify/data/resource";
import { generateClient } from "aws-amplify/data";
import amplifyOutputs from "../amplify_outputs.json";
import { Button, Input, Card, CardBody } from "@heroui/react";
import { Send } from "lucide-react";

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

  useEffect(() => {
    client.models.Todo.observeQuery().subscribe({
      next: (data) => setTodos([...data.items]),
    });
  }, []);

  function createTodo() {
    client.models.Todo.create({ content: window.prompt("Todo content") });
  }

  async function chat() {
    if (!userInput.trim() || isStreaming) return;

    const chatUrl = amplifyOutputs.custom?.chatUrl;
    if (!chatUrl) {
      setStreamingMessage("Error: Function URL not found in amplify_outputs.json");
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

    try {
      const response = await fetch(chatUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ messages: updatedMessages }),
      });

      if (!response.body) {
        throw new Error("No response body");
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let fullMessage = "";

      while (true) { // eslint-disable-line no-constant-condition
        const { done, value } = await reader.read();
        if (done) break;

        const chunk = decoder.decode(value, { stream: true });
        const lines = chunk.split('\n').filter(line => line.trim());
        
        for (const line of lines) {
          try {
            const event = JSON.parse(line);
            
            if (event.type === "content_block_delta" && event.delta?.type === "text_delta") {
              fullMessage += event.delta.text;
              setStreamingMessage(fullMessage);
            }
          } catch (e) {
            console.error("Failed to parse event:", e);
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
    } catch (error) {
      setStreamingMessage(`Error: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setIsStreaming(false);
      setStreamingMessage("");
    }
  }

  const handleKeyPress = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      chat();
    }
  };

  return (
    <main className="min-h-screen p-8 max-w-4xl mx-auto">
      <div className="mb-8">
        <h1 className="text-3xl font-bold mb-4">My todos</h1>
        <Button onClick={createTodo} color="primary">+ new</Button>
        <ul className="mt-4 space-y-2">
          {todos.map((todo) => (
            <li key={todo.id} className="p-2 bg-gray-100 rounded">{todo.content}</li>
          ))}
        </ul>
      </div>

      <div className="mt-8">
        <h2 className="text-2xl font-bold mb-4">Chat with Claude</h2>
        
        <Card className="mb-4">
          <CardBody>
            <div className="min-h-[200px] max-h-[500px] overflow-y-auto space-y-4">
              {messages.length === 0 && !streamingMessage && (
                <p className="text-gray-500">Type a message to start chatting...</p>
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
          <Button
            onClick={chat}
            disabled={isStreaming || !userInput.trim()}
            color="primary"
            isIconOnly
            size="lg"
          >
            <Send className="h-5 w-5" />
          </Button>
        </div>
        {isStreaming && (
          <p className="text-sm text-gray-500 mt-2">Claude is typing...</p>
        )}
      </div>
    </main>
  );
}

export default App;
