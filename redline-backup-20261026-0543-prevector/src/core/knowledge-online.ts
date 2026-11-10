// ─────────────────────────────────────────────────────────────────────────────
// Online knowledge ingest — pulls concise tool documentation (tldr-pages,
// raw GitHub) for every installed tool and stores it as command_syntax
// knowledge entries (source: 'docs'). tldr's example-first format is exactly
// what a small local model needs: one-liner description + copy-paste commands.
//
// Operator-triggered (Knowledge view button / /knowledge docs / REST) — never
// runs silently, and never executes the tools it documents.
// ─────────────────────────────────────────────────────────────────────────────
import { db } from './db'
import { audit } from './audit'
import { getRegistry, warmRegistry } from './tools/registry'
import { invalidateKnowledgeCache as invalidate } from './knowledge'

const RAW_BASE = 'https://raw.githubusercontent.com/tldr-pages/tldr/main/pages'

export interface IngestResult {
  ingested: string[]
  missing: string[]
  failed: { tool: string; error: string }[]
}

/** Fetch a tldr page for a binary, trying common/ then linux/ pages. */
async function fetchTldr(bin: string): Promise<string | null> {
  for (const dir of ['common', 'linux']) {
    try {
      const res = await fetch(`${RAW_BASE}/${dir}/${encodeURIComponent(bin)}.md`, {
        signal: AbortSignal.timeout(15_000),
      })
      if (res.ok) return await res.text()
    } catch { /* network hiccup — try next dir */ }
  }
  return null
}

/** Condense a tldr markdown page into one compact knowledge string. */
export function condenseTldr(md: string, maxChars = 450): string | null {
  const lines = md.split(/\r?\n/)
  const summary = lines.find((l) => l.startsWith('> '))?.slice(2).trim() ?? ''
  const examples: string[] = []
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (!line.startsWith('- ')) continue
    const desc = line.slice(2).replace(/\[([^\]]*)\]\{[^}]*\}/g, '$1').replace(/[:.]$/, '').trim()
    // the example command is the next non-empty `code` line
    const cmd = lines.slice(i + 1).find((l) => l.startsWith('`'))?.replace(/`/g, '').trim()
    if (cmd) examples.push(`${desc} → ${cmd}`)
    if (examples.length >= 6) break
  }
  if (!examples.length) return null
  const out = `${summary}${summary ? '. ' : ''}Examples: ${examples.join(' | ')}`
  return out.slice(0, maxChars)
}

/**
 * Ingest online docs for registry tools (default: the ones actually installed).
 * Replaces previous 'docs' entries per tool so re-runs stay clean.
 */
export async function ingestOnlineDocs(toolIds?: string[]): Promise<IngestResult> {
  // warm the installed-tools snapshot first — outside the agent service the
  // registry has no snapshot and would otherwise only see builtins
  await warmRegistry().catch(() => {})
  const registry = getRegistry({ resolveAvailability: true })
  const wanted = toolIds?.length
    ? registry.filter((t) => toolIds.includes(t.id) || toolIds.includes(t.detect.bin))
    : registry.filter((t) => t.availability === 'available')

  const result: IngestResult = { ingested: [], missing: [], failed: [] }
  for (const tool of wanted) {
    const bin = tool.detect.bin
    try {
      const md = await fetchTldr(bin)
      if (!md) { result.missing.push(bin); continue }
      const content = condenseTldr(md)
      if (!content) { result.missing.push(bin); continue }

      await db.knowledgeEntry.deleteMany({ where: { source: 'docs', tool: bin } })
      await db.knowledgeEntry.create({
        data: {
          kind: 'command_syntax',
          tool: bin,
          title: `docs: ${bin} usage (tldr)`,
          content,
          tags: JSON.stringify([bin, 'docs', 'tldr', ...Object.keys(tool.capabilities).slice(0, 3)]),
          source: 'docs',
        },
      })
      result.ingested.push(bin)
    } catch (e) {
      result.failed.push({ tool: bin, error: e instanceof Error ? e.message : String(e) })
    }
  }
  invalidate()
  if (result.ingested.length) {
    await audit('knowledge_docs_ingested', { ingested: result.ingested, missing: result.missing }, { actor: 'operator', verdict: 'info' })
  }
  return result
}
