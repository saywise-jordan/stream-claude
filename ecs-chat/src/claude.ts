import { Anthropic } from "@anthropic-ai/sdk";

export interface ClaudeStreamOptions {
  messages: Anthropic.MessageParam[];
  model?: string;
  maxTokens?: number;
  system?: string;
  simulate?: boolean;
}

const DEFAULT_MODEL = "claude-sonnet-4-5-20250929";
const DEFAULT_MAX_TOKENS = 2048;
const DEFAULT_SYSTEM_PROMPT =
  "You are a helpful AI assistant. You provide clear, accurate, and thoughtful responses to user questions. You are concise but thorough, and you acknowledge when you're uncertain about something. You aim to be conversational yet professional.";

const SIMULATED_RESPONSE =
  "This is a simulated response for testing purposes. The quick brown fox jumps over the lazy dog. This message is streamed in chunks to simulate real LLM behavior without making API calls.";
const CHUNK_SIZE = 15;
const CHUNK_DELAY_MS = 50;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function* createSimulatedStreamGenerator() {
  const messageId = `sim_${Date.now()}`;

  yield {
    type: "message_start" as const,
    message: {
      id: messageId,
      type: "message" as const,
      role: "assistant" as const,
      content: [],
      model: DEFAULT_MODEL,
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: 10, output_tokens: 0 },
    },
  };

  yield {
    type: "content_block_start" as const,
    index: 0,
    content_block: { type: "text" as const, text: "" },
  };

  let outputTokens = 0;
  for (let i = 0; i < SIMULATED_RESPONSE.length; i += CHUNK_SIZE) {
    const text = SIMULATED_RESPONSE.slice(i, i + CHUNK_SIZE);
    outputTokens += 1;
    await sleep(CHUNK_DELAY_MS);
    yield {
      type: "content_block_delta" as const,
      index: 0,
      delta: { type: "text_delta" as const, text },
    };
  }

  yield {
    type: "content_block_stop" as const,
    index: 0,
  };

  yield {
    type: "message_delta" as const,
    delta: { stop_reason: "end_turn" as const, stop_sequence: null },
    usage: { output_tokens: outputTokens },
  };

  yield {
    type: "message_stop" as const,
  };
}

interface SimulatedStream {
  [Symbol.asyncIterator]: () => AsyncGenerator<
    ReturnType<typeof createSimulatedStreamGenerator> extends AsyncGenerator<
      infer T
    >
      ? T
      : never
  >;
  abort: () => void;
}

function createSimulatedStream(): SimulatedStream {
  let aborted = false;
  const generator = createSimulatedStreamGenerator();

  return {
    async *[Symbol.asyncIterator]() {
      for await (const event of generator) {
        if (aborted) break;
        yield event;
      }
    },
    abort() {
      aborted = true;
    },
  };
}

let client: Anthropic | null = null;

export function getAnthropicClient(): Anthropic {
  if (!client) {
    client = new Anthropic({
      apiKey: process.env["ANTHROPIC_API_KEY"],
    });
    console.log("Anthropic client initialized");
  }
  return client;
}

export function createClaudeStream(options: ClaudeStreamOptions) {
  const {
    messages,
    model = DEFAULT_MODEL,
    maxTokens = DEFAULT_MAX_TOKENS,
    system = DEFAULT_SYSTEM_PROMPT,
    simulate = false,
  } = options;

  if (simulate) {
    console.log("Using simulated stream");
    return createSimulatedStream();
  }

  const anthropic = getAnthropicClient();
  return anthropic.messages.stream({
    model,
    max_tokens: maxTokens,
    messages,
    system,
  });
}
