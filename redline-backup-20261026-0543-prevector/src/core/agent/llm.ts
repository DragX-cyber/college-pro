// ─────────────────────────────────────────────────────────────────────────────
// LLM providers — local models AND API keys.
//   zai            : built-in SDK (works out of the box in this workspace)
//   ollama         : local, http://localhost:11434/v1 (no key)
//   lmstudio       : local, http://localhost:1234/v1 (no key)
//   llamacpp       : local llama-server, http://localhost:8080/v1 (no key)
//   openai-compat  : any OpenAI-compatible endpoint (vLLM, gateways, ...)
//   openai         : api.openai.com (needs key)
//   anthropic      : api.anthropic.com (needs key)
// All providers implement one normalized chatComplete() so the ReAct loop is
// provider-agnostic — a local model behaves exactly like a cloud model here.
// ─────────────────────────────────────────────────────────────────────────────
import { getSettings } from '../settings'
import { isStopRequested } from './abort'
import { createRequire } from 'node:module'
import type { LLMResult, ProviderId, ProviderInfo } from '../types'

let puterModule: { init: (token: string) => any } | undefined

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
}

export const PROVIDERS: ProviderInfo[] = [
  { id: 'zai', label: 'Z.AI (built-in)', description: 'Workspace SDK — zero config, works out of the box', local: false, needsKey: false, defaultBaseUrl: '', defaultModel: '' },
  { id: 'ollama', label: 'Ollama (local)', description: 'Local models via Ollama — llama3, qwen, mistral...', local: true, needsKey: false, defaultBaseUrl: 'http://localhost:11434/v1', defaultModel: 'llama3.1' },
  { id: 'lmstudio', label: 'LM Studio (local)', description: 'Local models via LM Studio server', local: true, needsKey: false, defaultBaseUrl: 'http://localhost:1234/v1', defaultModel: 'local-model' },
  { id: 'llamacpp', label: 'llama.cpp (local)', description: 'llama-server (llama.cpp built-in server) — start it with `llama-server -m model.gguf --host 0.0.0.0` and pick this', local: true, needsKey: false, defaultBaseUrl: 'http://localhost:8080/v1', defaultModel: 'local-model' },
  { id: 'openai-compat', label: 'OpenAI-compatible', description: 'Any compatible endpoint: vLLM, llama.cpp, OpenRouter, gateways', local: true, needsKey: false, defaultBaseUrl: 'http://localhost:8000/v1', defaultModel: '' },
  { id: 'openai', label: 'OpenAI (API key)', description: 'GPT family via api.openai.com', local: false, needsKey: true, defaultBaseUrl: 'https://api.openai.com/v1', defaultModel: 'gpt-4o-mini' },
  { id: 'anthropic', label: 'Anthropic (API key)', description: 'Claude family via api.anthropic.com', local: false, needsKey: true, defaultBaseUrl: 'https://api.anthropic.com', defaultModel: 'claude-sonnet-4-20250514' },
  { id: 'puter', label: 'Puter (Claude, user-pays)', description: 'Claude models (claude-sonnet-5-5, claude-opus-5, claude-haiku-5-5...) via Puter with your Puter AUTH TOKEN in the API-key field. No Anthropic key; usage bills your Puter account. Get the token: puter.com → your avatar → Dashboard/API → auth token. NOTE: Claude refuses REDLINE\'s ReAct/CTF prompt shape via Puter (Anthropic content filter, category "cyber") — fine for normal chat, unusable for agent turns.', local: false, needsKey: true, defaultBaseUrl: '', defaultModel: 'claude-sonnet-5-5' },
  { id: 'orca', label: 'OrcaRouter (free tier)', description: 'OpenAI-compatible router — z-ai/glm-5.3-flash-free and 200+ more. Put your ORCAROUTER key (sk-orca-...) in the API-key field. Real host: https://api.orcarouter.ai/v1 (the /models catalog on the bare domain is public browsing only).', local: false, needsKey: true, defaultBaseUrl: 'https://api.orcarouter.ai/v1', defaultModel: 'z-ai/glm-5.3-flash-free' },
]

/**
 * Ceiling on ONE LLM call. Generous by design: a 9B gguf on a partially
 * offloaded GPU prefills a ~3k-token ReAct prompt in ~2 minutes and decodes
 * at single-digit tok/s — a 120s cap there kills legitimate work (the server
 * logs `stop: cancel task` while we report the provider is unreachable).
 * Connection failures still surface in milliseconds; a response that never
 * arrives at all eats the full window, which is the correct failure mode.
 */
const LLM_TOTAL_TIMEOUT_MS = 15 * 60_000

async function fetchWithTimeout(url: string, init: RequestInit, timeoutMs = LLM_TOTAL_TIMEOUT_MS) {
  const ctrl = new AbortController()
  const t = setTimeout(() => ctrl.abort(), timeoutMs)
  try {
    return await fetch(url, { ...init, signal: ctrl.signal })
  } catch (e) {
    if (ctrl.signal.aborted) {
      throw new Error(
        `model did not finish within ${Math.round(timeoutMs / 1000)}s — ` +
        'prefill/decode too slow for one call (huge prompt, or model handling too much on CPU)',
      )
    }
    throw e
  } finally {
    clearTimeout(t)
  }
}

async function openAICompatible(
  baseUrl: string,
  model: string,
  apiKey: string | undefined,
  messages: ChatMessage[],
  extra: Record<string, unknown> = {},
  onChunk?: (chunk: string) => void,
  sessionId?: string
): Promise<string> {
  const isStreaming = Boolean(onChunk)
  const res = await fetchWithTimeout(`${baseUrl.replace(/\/$/, '')}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
    },
    body: JSON.stringify({
      model,
      messages,
      temperature: 0.2,
      stream: isStreaming,
      ...extra
    }),
  })
  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new Error(`provider HTTP ${res.status}: ${body.slice(0, 300)}`)
  }

  // Non-streaming fallback
  if (!isStreaming || !res.body) {
    const json: any = await res.json()
    const content = json?.choices?.[0]?.message?.content
    if (!content) throw new Error('provider returned an empty completion')
    return content
  }

  // SSE Stream reader
  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let fullContent = ''

  while (true) {
    if (sessionId && isStopRequested(sessionId)) {
      try { await reader.cancel() } catch {}
      break
    }
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    const lines = buffer.split('\n')
    buffer = lines.pop() || ''

    for (const line of lines) {
      const trimmed = line.trim()
      if (!trimmed || !trimmed.startsWith('data: ')) continue
      const dataStr = trimmed.slice(6).trim()
      if (dataStr === '[DONE]') continue
      try {
        const parsed = JSON.parse(dataStr)
        const delta = parsed?.choices?.[0]?.delta?.content ?? parsed?.choices?.[0]?.message?.content ?? ''
        if (delta) {
          fullContent += delta
          onChunk?.(delta)
        }
      } catch {}
    }
  }

  if (buffer.trim().startsWith('data: ')) {
    const dataStr = buffer.trim().slice(6).trim()
    if (dataStr !== '[DONE]') {
      try {
        const parsed = JSON.parse(dataStr)
        const delta = parsed?.choices?.[0]?.delta?.content ?? ''
        if (delta) {
          fullContent += delta
          onChunk?.(delta)
        }
      } catch {}
    }
  }

  if (!fullContent && !isStreaming) {
    throw new Error('provider returned an empty completion')
  }
  return fullContent
}

async function anthropicChat(baseUrl: string, model: string, apiKey: string, messages: ChatMessage[]): Promise<string> {
  const system = messages.filter((m) => m.role === 'system').map((m) => m.content).join('\n\n')
  const rest = messages.filter((m) => m.role !== 'system').map((m) => ({ role: m.role, content: m.content }))
  const res = await fetchWithTimeout(`${baseUrl.replace(/\/$/, '')}/v1/messages`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({ model, system, messages: rest, max_tokens: 4096 }),
  })
  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new Error(`anthropic HTTP ${res.status}: ${body.slice(0, 300)}`)
  }
  const json: any = await res.json()
  const content = (json?.content ?? []).filter((b: any) => b?.type === 'text').map((b: any) => b.text).join('')
  if (!content) throw new Error('anthropic returned an empty completion')
  return content
}

async function puterChat(token: string, model: string, messages: ChatMessage[]): Promise<string> {
  if (!token) {
    throw new Error(
      'puter provider needs your Puter auth token in the API-key field (Settings → provider Puter). ' +
      'Get it from puter.com → Dashboard → auth token. “No key” only applies to browser apps; ' +
      'server-side calls are billed to the token\'s Puter account.',
    )
  }
  // The package ships an ESM world but its Node/CJS shim is what actually
  // initializes server-side — and Bun's ESM import of that shim hangs, while
  // require() is instant on both runtimes. Load through a CJS require cache.
  const req = createRequire(import.meta.url)
  const mod = puterModule ?? (puterModule = req('@heyputer/puter.js/src/init.cjs'))
  const puter = mod.init(token)
  const puterModel = model && model !== 'local-model' && !/^(local|)$/i.test(model) ? model : 'claude-sonnet-5-5'
  // Guard every server-side SDK call with the same ceiling the raw providers use.
  let timer: NodeJS.Timeout | undefined
  const timeout = new Promise<never>((_, rej) => {
    timer = setTimeout(
      () => rej(new Error(`puter chat took more than ${Math.round(LLM_TOTAL_TIMEOUT_MS / 1000)}s — aborted before the model replied`)),
      LLM_TOTAL_TIMEOUT_MS,
    )
  })
  try {
    const resp = await Promise.race([puter.ai.chat(messages as any, { model: puterModel }), timeout])
    return extractPuterText(resp)
  } finally {
    clearTimeout(timer)
  }
}

function extractPuterText(resp: any): string {
  const c = resp?.message?.content
  if (typeof c === 'string' && c.trim()) return c
  if (Array.isArray(c)) {
    const joined = c.map((p: any) => (typeof p === 'string' ? p : p?.text ?? '')).join('')
    if (joined.trim()) return joined
  }
  if (typeof resp?.text === 'string' && resp.text.trim()) return resp.text
  if (Array.isArray(resp?.content)) return resp.content.map((p: any) => p?.text ?? '').join('')
  return ''
}

async function zaiChat(messages: ChatMessage[]): Promise<string> {
  // SDK is server-side only; dynamic import keeps the CLI portable.
  const mod: any = await import('z-ai-web-dev-sdk')
  const ZAI = mod.default ?? mod
  const zai = await ZAI.create()
  // The SDK takes the system prompt as the first assistant message.
  const sdkMessages = messages.map((m) => ({
    role: m.role === 'system' ? 'assistant' : m.role,
    content: m.content,
  }))
  const completion = await zai.chat.completions.create({
    messages: sdkMessages,
    thinking: { type: 'disabled' },
  })
  const content = completion?.choices?.[0]?.message?.content
  if (!content) throw new Error('zai returned an empty completion')
  return content
}

export async function chatComplete(
  messages: ChatMessage[],
  opts: {
    sessionId?: string
    provider?: ProviderId
    model?: string
    baseUrl?: string
    apiKey?: string
    onChunk?: (chunk: string) => void
  } = {}
): Promise<LLMResult> {
  const settings = await getSettings()
  const provider = opts.provider ?? settings.provider
  const model = opts.model || settings.model
  const baseUrl = opts.baseUrl || settings.baseUrl
  const apiKey = opts.apiKey || settings.apiKey
  const onChunk = opts.onChunk

  try {
    let content: string
    switch (provider) {
      case 'zai':
        content = await zaiChat(messages)
        break
      case 'ollama':
        content = await openAICompatible(baseUrl || 'http://localhost:11434/v1', model || 'llama3.1', undefined, messages, {}, onChunk, opts.sessionId)
        break
      case 'lmstudio':
        content = await openAICompatible(baseUrl || 'http://localhost:1234/v1', model || 'local-model', undefined, messages, {}, onChunk, opts.sessionId)
        break
      case 'llamacpp':
        content = await openAICompatible(baseUrl || 'http://localhost:8080/v1', model || 'local-model', undefined, messages, { cache_prompt: true, top_p: 0.9, repeat_penalty: 1.1 }, onChunk, opts.sessionId)
        break
      case 'openai-compat':
        content = await openAICompatible(baseUrl || 'http://localhost:8000/v1', model || 'local-model', apiKey || undefined, messages, {}, onChunk, opts.sessionId)
        break
      case 'openai':
        content = await openAICompatible('https://api.openai.com/v1', model || 'gpt-4o-mini', apiKey || undefined, messages, {}, onChunk, opts.sessionId)
        break
      case 'anthropic':
        content = await anthropicChat('https://api.anthropic.com', model || 'claude-sonnet-4-20250514', apiKey || '', messages)
        break
      case 'puter':
        content = await puterChat(apiKey || '', model || 'claude-sonnet-5-5', messages)
        break
      case 'orca':
        content = await openAICompatible(baseUrl || 'https://api.orcarouter.ai/v1', model || 'z-ai/glm-5.3-flash-free', apiKey || undefined, messages, {}, onChunk, opts.sessionId)
        break
      default:
        throw new Error(`unknown provider: ${provider}`)
    }
    return { content, provider, model: model || provider }
  } catch (e: any) {
    const msg = String(e?.message ?? e)
    const localDefaults: Record<string, string> = {
      ollama: 'http://localhost:11434/v1',
      lmstudio: 'http://localhost:1234/v1',
      llamacpp: 'http://localhost:8080/v1',
    }
    const fix = provider === 'zai'
      ? undefined
      : provider in localDefaults
        ? `Is the local server running? ${provider === 'llamacpp' ? 'Start it: llama-server -m <model.gguf> --host 0.0.0.0. ' : ''}Test it: curl ${baseUrl || localDefaults[provider]}/models`
        : provider === 'anthropic' || provider === 'openai'
          ? 'Check the API key in Settings'
          : provider === 'puter'
            ? 'Put your Puter auth token in the API-key field (puter.com → Dashboard → auth token)'
            : 'Check baseUrl / model name in Settings'
    return { content: '', provider, model: model || provider, error: msg, ...(fix ? { errorFix: fix } as any : {}) }
  }
}
