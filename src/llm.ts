// Vendored from DisputeDesk (github.com/ttimesai-star/disputedesk, MIT, same author) - keep in sync by hand.
// Minimal OpenAI-compatible chat client (Gemini and Groq both speak this).
// Primary + optional fallback provider, both from env.
// Keys stay server-side and are never logged.

export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
}

export interface ToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

export interface ToolSpec {
  type: "function";
  function: { name: string; description: string; parameters: Record<string, unknown> };
}

export interface ChatResult {
  content: string | null;
  toolCalls: ToolCall[];
  provider: string;
  model: string;
}

export interface Llm {
  chat(messages: ChatMessage[], tools?: ToolSpec[]): Promise<ChatResult>;
}

interface Provider {
  name: string;
  baseUrl: string;
  apiKey: string;
  model: string;
}

export class OpenAiCompatibleLlm implements Llm {
  // Plain fields, not parameter properties: Node's type stripping only handles erasable syntax.
  private readonly providers: Provider[];
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(providers: Provider[], timeoutMs = 30_000, fetchImpl: typeof fetch = fetch) {
    if (providers.length === 0) throw new Error("No LLM provider configured");
    this.providers = providers;
    this.timeoutMs = timeoutMs;
    this.fetchImpl = fetchImpl;
  }

  async chat(messages: ChatMessage[], tools?: ToolSpec[]): Promise<ChatResult> {
    const errors: string[] = [];
    for (const p of this.providers) {
      // One bounded retry per provider for transient 429/5xx (free tiers flap).
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          return await this.chatWith(p, messages, tools);
        } catch (error) {
          const msg = (error as Error).message;
          if (!/HTTP (429|5\d\d)/.test(msg) || attempt === 1) {
            errors.push(msg);
            break;
          }
          await new Promise((r) => setTimeout(r, 2000));
        }
      }
    }
    throw new Error(errors.join(" | ") || "All LLM providers failed");
  }

  private async chatWith(p: Provider, messages: ChatMessage[], tools?: ToolSpec[]): Promise<ChatResult> {
    const res = await this.fetchImpl(`${p.baseUrl.replace(/\/$/, "")}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${p.apiKey}` },
      body: JSON.stringify({ model: p.model, messages, temperature: 0.2, ...(tools?.length ? { tools, tool_choice: "auto" } : {}) }),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (!res.ok) {
      const detail = (await res.text().catch(() => "")).replace(/\s+/g, " ").slice(0, 200);
      throw new Error(`${p.name} LLM HTTP ${res.status}: ${detail}`);
    }
    const data = (await res.json()) as { choices?: { message?: { content?: string | null; tool_calls?: ToolCall[] } }[] };
    const msg = data.choices?.[0]?.message;
    if (!msg) throw new Error(`${p.name} returned no message`);
    return { content: msg.content ?? null, toolCalls: msg.tool_calls ?? [], provider: p.name, model: p.model };
  }
}

/**
 * GEMINI_API_KEY (+ GEMINI_MODEL)  primary, Google's OpenAI-compatible endpoint (free tier)
 * GROQ_API_KEY   (+ GROQ_MODEL)    fallback, Groq (free tier)
 * Returns null when no key is set: the pipeline then uses the rule-based drafter only.
 */
export function createLlm(env: NodeJS.ProcessEnv = process.env, fetchImpl: typeof fetch = fetch): Llm | null {
  const providers: Provider[] = [];
  if (env.GEMINI_API_KEY) {
    providers.push({ name: "gemini", baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai", apiKey: env.GEMINI_API_KEY, model: env.GEMINI_MODEL || "gemini-2.5-flash" });
  }
  if (env.GROQ_API_KEY) {
    providers.push({ name: "groq", baseUrl: "https://api.groq.com/openai/v1", apiKey: env.GROQ_API_KEY, model: env.GROQ_MODEL || "llama-3.3-70b-versatile" });
  }
  return providers.length > 0 ? new OpenAiCompatibleLlm(providers, 30_000, fetchImpl) : null;
}

/** Extracts the first JSON object from a model reply (handles ```json fences and chatter). */
export function parseJsonObject(text: string | null): Record<string, unknown> | null {
  if (!text) return null;
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    const v = JSON.parse(text.slice(start, end + 1));
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}
