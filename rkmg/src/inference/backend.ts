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
  /** Literal bearer token for a remote tier (prefer api_key_env to keep secrets
   *  out of the committed config). */
  api_key?: string;
  /** Name of the env var holding the bearer token for a remote tier, e.g.
   *  "DEEPSEEK_API_KEY". Resolved at call time; wins over api_key when both set. */
  api_key_env?: string;
  /** How hard to constrain this tier's output (P0.2 — reasoning freedom):
   *   'schema' — strict llama-server grammar, byte-exact action validity (local only)
   *   'json'   — JSON-object mode only: valid JSON, but the model structures its
   *              own reasoning in `thought` instead of fighting a 9-branch grammar
   *   'off'    — no constraint: max reasoning freedom; relies on RedLine's tolerant
   *              parser + repair. Use if the model is still too rote on 'json'.
   *  Default: 'json' for a remote/keyed tier (schema is llama-server-only), else
   *  'schema'. A reasoning/decision tier benefits from 'json'. */
  structured_output?: 'schema' | 'json' | 'off';
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

  /** Resolve this tier's bearer token (env var wins over literal). '' when none. */
  private resolveApiKey(): string {
    const fromEnv = this.config.api_key_env ? process.env[this.config.api_key_env] : undefined;
    return (fromEnv || this.config.api_key || '').trim();
  }

  /** True when this tier expects an API key (remote provider) but none is
   *  resolvable — so a request routed here would fail auth. The router uses this
   *  to transparently fall back to a local tier, keeping the gateway runnable
   *  out of the box when the operator hasn't configured a remote key yet. */
  public needsKeyButMissing(): boolean {
    return Boolean(this.config.api_key_env) && !this.resolveApiKey();
  }

  /** Request headers — adds Authorization only for a remote (keyed) tier. */
  private buildHeaders(): Record<string, string> {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    const key = this.resolveApiKey();
    if (key) headers['Authorization'] = `Bearer ${key}`;
    return headers;
  }

  /** Structured-output constraint (P0.2). Returns undefined for 'off' (no
   *  constraint — maximum reasoning freedom). A local llama-server accepts a
   *  JSON *schema* (compiled to a GBNF grammar) for byte-exact action validity;
   *  a remote OpenAI-compatible API (keyed tier) rejects that non-standard
   *  field, so it can only use plain JSON mode. The default frees a remote tier
   *  to 'json' and keeps a local tier on 'schema' unless the config overrides. */
  private responseFormat(): Record<string, any> | undefined {
    const remote = Boolean(this.resolveApiKey());
    const mode = this.config.structured_output ?? (remote ? 'json' : 'schema');
    if (mode === 'off') return undefined;
    // 'schema' is llama-server-only; a remote tier is forced down to 'json'.
    if (mode === 'json' || remote) return { type: 'json_object' };
    return { type: 'json_object', schema: REDLINE_ACTION_JSON_SCHEMA };
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
      temperature: this.config.temperature ?? temperature ?? 0.2, // tier config wins (gateway owns model params)
      max_tokens: maxTokens ?? this.config.max_tokens ?? 1024,
      stream: false,
      // Prompt cache preservation invariant: ensure prefix match KV-cache is reused
      cache_prompt: this.config.cache_prompt ?? true,
      top_p: this.config.top_p ?? 0.9,
      repeat_penalty: this.config.repeat_penalty ?? 1.1
    };

    if (grammarConstraint) {
      // Structured output constraint — schema (local llama-server → GBNF),
      // plain JSON mode, or none ('off'). See responseFormat().
      const rf = this.responseFormat();
      if (rf) bodyPayload.response_format = rf;
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 120_000); // 2 minute ceiling

    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: this.buildHeaders(),
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
      temperature: this.config.temperature ?? temperature ?? 0.2, // tier config wins (gateway owns model params)
      max_tokens: maxTokens ?? this.config.max_tokens ?? 1024,
      stream: true,
      cache_prompt: this.config.cache_prompt ?? true,
      top_p: this.config.top_p ?? 0.9,
      repeat_penalty: this.config.repeat_penalty ?? 1.1
    };

    if (grammarConstraint) {
      const rf = this.responseFormat();
      if (rf) bodyPayload.response_format = rf;
    }

    const res = await fetch(url, {
      method: 'POST',
      headers: this.buildHeaders(),
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

