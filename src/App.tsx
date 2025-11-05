import { useEffect, useState } from "react";
import type { Schema } from "../amplify/data/resource";
import { generateClient } from "aws-amplify/data";
import amplifyOutputs from "../amplify_outputs.json";
import { Button, Input, Card, CardBody } from "@heroui/react";
import { Send } from "lucide-react";

const client = generateClient<Schema>();

function App() {
  const [todos, setTodos] = useState<Array<Schema["Todo"]["type"]>>([]);
  const [chatMessage, setChatMessage] = useState<string>("");
  const [userInput, setUserInput] = useState<string>("");
  const [isStreaming, setIsStreaming] = useState<boolean>(false);

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
      setChatMessage("Error: Function URL not found in amplify_outputs.json");
      return;
    }

    setIsStreaming(true);
    setChatMessage("");
    const messageToSend = userInput;
    setUserInput("");

    try {
      const response = await fetch(chatUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ message: messageToSend }),
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
        const lines = chunk.split('\n');
        
        for (const line of lines) {
          if (line.startsWith('data: ')) {
            const data = line.slice(6);
            if (data === '[DONE]') continue;
            
            try {
              const parsed = JSON.parse(data);
              if (parsed.text) {
                fullMessage += parsed.text;
                setChatMessage(fullMessage);
              }
            } catch (e) {
              console.error("Failed to parse chunk:", e);
            }
          }
        }
      }
    } catch (error) {
      setChatMessage(`Error: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setIsStreaming(false);
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
            <pre className="whitespace-pre-wrap min-h-[100px] max-h-[400px] overflow-y-auto">
              {chatMessage || "Type a message to start chatting..."}
            </pre>
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
