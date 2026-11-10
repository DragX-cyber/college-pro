// ─────────────────────────────────────────────────────────────────────────────
// Knowledge import — turn operator documents (PDF / DOCX / CSV / TXT / MD /
// JSON / logs) into knowledge-base entries using the configured LLM.
//
// Pipeline: extract raw text → chunk → ONE structured conversion prompt per
// chunk (the LLM returns strict JSON entries) → validate + clamp → store with
// source 'import'. Nothing executes; this is document processing only.
// ─────────────────────────────────────────────────────────────────────────────
import { createKnowledge, KNOWLEDGE_KINDS, type KnowledgeKind, type KnowledgeRow } from './knowledge'
import { chatComplete } from './agent/llm'

const MAX_FILE_BYTES = 5 * 1024 * 1024 // 5MB upload cap
const MAX_TEXT_CHARS = 60_000 // per document, after extraction
const CHUNK_CHARS = 9_000 // per LLM conversion call
const MAX_ENTRIES_PER_DOC = 40

export interface ImportResult {
  ok: boolean
  entries: KnowledgeRow[]
  error?: string
  detail?: string
}

// ─── text extraction ─────────────────────────────────────────────────────────

export async function extractText(buffer: Buffer, filename: string): Promise<string> {
  const ext = filename.toLowerCase().split('.').pop() ?? ''
  if (ext === 'pdf') {
    // pdf-parse v2: class API, dynamic import keeps it out of other bundles
    const { PDFParse } = await import('pdf-parse')
    const parser = new PDFParse({ data: new Uint8Array(buffer) })
    const parsed = await parser.getText()
    return String(parsed?.text ?? '')
  }
  if (ext === 'docx') {
    const mammoth: any = await import('mammoth')
    const res = await mammoth.extractRawText({ buffer })
    return String(res?.value ?? '')
  }
  // txt / md / csv / json / log / anything textual — decode and let the LLM sort it out
  return buffer.toString('utf8')
}

// ─── the conversion prompt ───────────────────────────────────────────────────

const SYSTEM_PROMPT = `You convert operator documents into entries for REDLINE, an authorized red-team platform's knowledge base. The entries are injected into an AI agent's context, so they must be SHORT, IMPERATIVE and OPERATIONALLY USEFUL.

Return ONLY a JSON array — no prose, no markdown fences, no commentary. Each element:
{"kind":"tool_usage|command_syntax|mistake|planning","tool":"<binary name or null>","title":"<short imperative title, <=80 chars>","content":"<1-3 sentence actionable instruction, <=350 chars, include EXACT commands/flags when relevant>","tags":["lowercase","tags"]}

kind guide:
- tool_usage: what a tool is for and how to use it well
- command_syntax: exact command forms, flags, gotchas
- mistake: a failure mode and how to avoid/fix it
- planning: methodology, ordering, decision rules

Extraction rules:
- Keep ONLY security/red-team-relevant knowledge: recon, scanning, exploitation, tooling, methodology, lessons learned.
- content must be self-contained — an agent reading only this line learns something actionable.
- Preserve exact commands, flags, ports, version numbers, error signatures.
- Drop marketing, tables of contents, page furniture, author info, references, licensing.
- No duplicates; merge overlapping points. Max 8 entries per batch.
- If the text contains nothing useful, return []`

async function convertChunk(text: string): Promise<rawEntry[]> {
  const res = await chatComplete([
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: `Document content (part ${'x'}):\n\n${text}` },
  ])
  if (res.error || !res.content) throw new Error(`LLM conversion failed: ${res.error ?? 'empty response'} — is the provider running?`)
  return parseEntryArray(res.content)
}

interface rawEntry { kind?: string; tool?: string | null; title?: string; content?: string; tags?: unknown }

/** Robust JSON-array extraction: strips fences, finds the outer [...] block. */
export function parseEntryArray(raw: string): rawEntry[] {
  let s = raw.trim()
  s = s.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '')
  const start = s.indexOf('[')
  const end = s.lastIndexOf(']')
  if (start === -1 || end === -1 || end <= start) return []
  try {
    const v = JSON.parse(s.slice(start, end + 1))
    return Array.isArray(v) ? v : []
  } catch { return [] }
}

function sanitize(e: rawEntry): Parameters<typeof createKnowledge>[0] | null {
  const kind = String(e.kind ?? '') as KnowledgeKind
  if (!KNOWLEDGE_KINDS.includes(kind)) return null
  const title = String(e.title ?? '').trim()
  const content = String(e.content ?? '').trim()
  if (!title || !content) return null
  const tags = Array.isArray(e.tags) ? e.tags.map((t) => String(t).toLowerCase()).slice(0, 8) : []
  return {
    kind,
    tool: e.tool ? String(e.tool).trim().toLowerCase() : null,
    title: title.slice(0, 160),
    content: content.slice(0, 500),
    tags,
    source: 'import',
  }
}

// ─── the import pipeline ─────────────────────────────────────────────────────

export async function importDocument(filename: string, buffer: Buffer): Promise<ImportResult> {
  if (buffer.length > MAX_FILE_BYTES) {
    return { ok: false, entries: [], error: `file too large (${(buffer.length / 1024 / 1024).toFixed(1)}MB) — cap is 5MB` }
  }
  let text: string
  try {
    text = await extractText(buffer, filename)
  } catch (e) {
    return { ok: false, entries: [], error: `could not extract text from ${filename}: ${e instanceof Error ? e.message : String(e)}` }
  }
  text = text.replace(/\u0000/g, '').trim()
  if (text.length < 40) {
    return { ok: false, entries: [], error: `extracted no usable text from ${filename} (got ${text.length} chars) — scanned PDFs/images are not supported` }
  }
  text = text.slice(0, MAX_TEXT_CHARS)

  const chunks: string[] = []
  for (let i = 0; i < text.length; i += CHUNK_CHARS) chunks.push(text.slice(i, i + CHUNK_CHARS))

  const entries: KnowledgeRow[] = []
  const errors: string[] = []
  for (const chunk of chunks) {
    let raw: rawEntry[]
    try {
      raw = await convertChunk(chunk)
    } catch (e) {
      errors.push(e instanceof Error ? e.message : String(e))
      continue
    }
    for (const r of raw) {
      if (entries.length >= MAX_ENTRIES_PER_DOC) break
      const clean = sanitize(r)
      if (!clean) continue
      entries.push(await createKnowledge(clean))
    }
    if (entries.length >= MAX_ENTRIES_PER_DOC) break
  }

  if (!entries.length) {
    return { ok: false, entries: [], error: 'the model converted no usable entries', detail: errors.join('; ') || 'the document may contain no security-relevant knowledge' }
  }
  return { ok: true, entries, detail: `${chunks.length} chunk(s) processed${errors.length ? ` · ${errors.length} chunk(s) failed: ${errors[0]}` : ''}` }
}
