import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { REDLINE_ACTION_JSON_SCHEMA, validateRedLineAction } from './schema.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface BackendTierConfig {
  name: string;
  endpoint: string;
  description?: string;
  max_tokens?: number;
  temperature?: number;
  cache_prompt?: boolean;
  top_p?: number;
  repeat_penalty?: number;
  actions?: string[];
}

export interface CompletionOptions {
  tier: BackendTierConfig;
  messages: ChatMessage[];
  maxTokens?: number;
  temperature?: number;
  stream?: boolean;
  grammarConstraint?: boolean;
}

export interface CompletionResult {
  id: string;
  model: string;
  content: string;
  finishReason: string;
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
}

let cachedGrammar: string | null = null;

export function getRedLineGrammar(): string {
  if (cachedGrammar) return cachedGrammar;
  try {
    const grammarPath = path.resolve(__dirname, 'grammar.gbnf');
    if (fs.existsSync(grammarPath)) {
      cachedGrammar = fs.readFileSync(grammarPath, 'utf-8');
      return cachedGrammar;
    }
  } catch {
    // fallback if file cannot be read directly
  }
  return '';
}

/**
 * Single gateway abstraction for all inference backend calls (llama-server).
 * RedLine never communicates with llama-server directly; all traffic flows through here.
 */
export class InferenceBackend {
  private config: BackendTierConfig;

  constructor(config: BackendTierConfig) {
    this.config = config;
  }

  public getConfig(): BackendTierConfig {
    return this.config;
  }

  /**
   * Check if this backend server is responsive.
   */
  public async health(): Promise<{ ok: boolean; status: number | string; error?: string }> {
    const url = `${this.config.endpoint.replace(/\/$/, '')}/health`;
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(3000) });
      return { ok: res.ok, status: res.status };
    } catch (e: any) {
      // Some llama-server builds don't have /health, check /models
      try {
        const modelsRes = await fetch(`${this.config.endpoint.replace(/\/$/, '')}/v1/models`, {
          signal: AbortSignal.timeout(3000)
        });
        return { ok: modelsRes.ok, status: modelsRes.status };
      } catch (err: any) {
        return { ok: false, status: 'unreachable', error: String(err?.message || err) };
      }
    }
  }

  /**
   * Execute chat completion on the llama-server backend.
   */
  public async complete(options: CompletionOptions): Promise<CompletionResult> {
    const { messages, maxTokens, temperature, grammarConstraint = true } = options;
    const endpoint = this.config.endpoint.replace(/\/$/, '');
    const url = `${endpoint}/v1/chat/completions`;

    const bodyPayload: Record<string, any> = {
      model: this.config.name,
      messages,
      temperature: temperature ?? this.config.temperature ?? 0.2,
      max_tokens: maxTokens ?? this.config.max_tokens ?? 1024,
      stream: false,
      // Prompt cache preservation invariant: ensure prefix match KV-cache is reused
      cache_prompt: this.config.cache_prompt ?? true,
      top_p: this.config.top_p ?? 0.9,
      repeat_penalty: this.config.repeat_penalty ?? 1.1
    };

    if (grammarConstraint) {
      // Structured output constraint via schema (llama-server translates to grammar internally)
      bodyPayload.response_format = {
        type: 'json_object',
        schema: REDLINE_ACTION_JSON_SCHEMA
      };
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 120_000); // 2 minute ceiling

    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(bodyPayload),
        signal: controller.signal
      });

      if (!res.ok) {
        const errText = await res.text().catch(() => '');
        throw new Error(`llama-server returned HTTP ${res.status}: ${errText.slice(0, 300)}`);
      }

      const json: any = await res.json();
      const choice = json?.choices?.[0];
      const content = choice?.message?.content ?? '';

      // Validate JSON action protocol
      let parsed: any = null;
      try {
        parsed = JSON.parse(content);
        const check = validateRedLineAction(parsed);
        if (!check.valid) {
          console.warn(`[RKMG Backend] Warning: Action schema mismatch (${check.error}). Content: ${content.slice(0, 100)}`);
        }
      } catch (err) {
        console.warn(`[RKMG Backend] Warning: Response was not valid JSON: ${content.slice(0, 100)}`);
      }

      return {
        id: json?.id ?? `chatcmpl-${Date.now()}`,
        model: this.config.name,
        content,
        finishReason: choice?.finish_reason ?? 'stop',
        usage: json?.usage ?? {
          prompt_tokens: Math.round(messages.reduce((sum, m) => sum + m.content.length, 0) / 4),
          completion_tokens: Math.round(content.length / 4),
          total_tokens: Math.round((messages.reduce((sum, m) => sum + m.content.length, 0) + content.length) / 4)
        }
      };
    } catch (e: any) {
      if (controller.signal.aborted) {
        throw new Error(`Inference timeout: backend ${this.config.name} at ${this.config.endpoint} did not respond within 120s`);
      }
      throw e;
    } finally {
      clearTimeout(timeout);
    }
  }

  /**
   * Execute streaming chat completion, yielding standard chunks.
   */
  public async *streamComplete(options: CompletionOptions): AsyncGenerator<string, void, unknown> {
    const { messages, maxTokens, temperature, grammarConstraint = true } = options;
    const endpoint = this.config.endpoint.replace(/\/$/, '');
    const url = `${endpoint}/v1/chat/completions`;

    const bodyPayload: Record<string, any> = {
      model: this.config.name,
      messages,
      temperature: temperature ?? this.config.temperature ?? 0.2,
      max_tokens: maxTokens ?? this.config.max_tokens ?? 1024,
      stream: true,
      cache_prompt: this.config.cache_prompt ?? true,
      top_p: this.config.top_p ?? 0.9,
      repeat_penalty: this.config.repeat_penalty ?? 1.1
    };

    if (grammarConstraint) {
      bodyPayload.response_format = {
        type: 'json_object',
        schema: REDLINE_ACTION_JSON_SCHEMA
      };
    }

    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(bodyPayload)
    });

    if (!res.ok || !res.body) {
      const errText = await res.text().catch(() => '');
      throw new Error(`llama-server stream HTTP ${res.status}: ${errText.slice(0, 300)}`);
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed.startsWith('data: ')) {
          yield trimmed;
        }
      }
    }
  }
}

