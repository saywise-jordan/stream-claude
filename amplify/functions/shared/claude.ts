import { Anthropic } from "@anthropic-ai/sdk";

export interface ClaudeStreamOptions {
  messages: Anthropic.MessageParam[];
  model?: string;
  maxTokens?: number;
  system?: string;
}

const DEFAULT_MODEL = "claude-sonnet-4-5-20250929";
const DEFAULT_MAX_TOKENS = 2048;
const DEFAULT_SYSTEM_PROMPT =
  "You are a helpful AI assistant. You provide clear, accurate, and thoughtful responses to user questions. You are concise but thorough, and you acknowledge when you're uncertain about something. You aim to be conversational yet professional.";

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
  const anthropic = getAnthropicClient();
  const {
    messages,
    model = DEFAULT_MODEL,
    maxTokens = DEFAULT_MAX_TOKENS,
    system = DEFAULT_SYSTEM_PROMPT,
  } = options;

  return anthropic.messages.stream({
    model,
    max_tokens: maxTokens,
    messages,
    system,
  });
}
