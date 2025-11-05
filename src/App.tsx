import { useEffect, useState } from "react";
import type { Schema } from "../amplify/data/resource";
import { generateClient } from "aws-amplify/data";
import amplifyOutputs from "../amplify_outputs.json";

const client = generateClient<Schema>();

function App() {
  const [todos, setTodos] = useState<Array<Schema["Todo"]["type"]>>([]);
  const [chatMessage, setChatMessage] = useState<string>("");
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
    const chatUrl = amplifyOutputs.custom?.chatUrl;
    if (!chatUrl) {
      setChatMessage("Error: Function URL not found in amplify_outputs.json");
      return;
    }

    setIsStreaming(true);
    setChatMessage("");

    try {
      const response = await fetch(chatUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({}),
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
        fullMessage += chunk;
        setChatMessage(fullMessage);
      }
    } catch (error) {
      setChatMessage(`Error: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setIsStreaming(false);
    }
  }

  return (
    <main>
      <h1>My todos</h1>
      <button onClick={createTodo}>+ new</button>
      <ul>
        {todos.map((todo) => (
          <li key={todo.id}>{todo.content}</li>
        ))}
      </ul>
      <button onClick={chat} disabled={isStreaming}>
        {isStreaming ? "Streaming..." : "Chat"}
      </button>
      <pre style={{ whiteSpace: "pre-wrap", marginTop: "10px" }}>
        {chatMessage || "Click button to chat"}
      </pre>
      <div>
        🥳 App successfully hosted. Try creating a new todo.
        <br />
        <a href="https://docs.amplify.aws/react/start/quickstart/#make-frontend-updates">
          Review next step of this tutorial.
        </a>
      </div>
    </main>
  );
}

export default App;
