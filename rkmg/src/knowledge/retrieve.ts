import { embedQuery } from './embed.js';
import { searchHybrid, SearchHit } from './index.js';

export interface RetrievalOptions {
  tool?: string | null;
  limit?: number;
}

/**
 * Formats retrieved knowledge entries into a stable, compact Markdown block.
 * Byte-for-byte deterministic across identical results.
 */
export function formatKnowledgeBlock(hits: SearchHit[]): string {
  if (!hits.length) return '';

  const lines = hits.map(({ entry }) => {
    const kindTag = `[${entry.kind}${entry.tool ? `:${entry.tool}` : ''}]`;
    const cleanContent = entry.content.replace(/\r?\n/g, ' ').trim();
    return `- ${kindTag} ${entry.title}: ${cleanContent}`;
  });

  return `## KNOWLEDGE (RKMG) - planning rules for this engagement (follow over your own habits):\n${lines.join('\n')}\n`;
}

/**
 * Retrieve top-k knowledge entries for an engagement task query.
 * Hybrid search: attempts semantic embedding first, gracefully degrades to keyword scoring if offline.
 */
export async function retrieveKnowledgeForTask(
  query: string,
  options: RetrievalOptions = {}
): Promise<{ textBlock: string; hits: SearchHit[]; query: string }> {
  const trimmed = (query || '').slice(0, 300).trim();
  if (!trimmed) {
    return { textBlock: '', hits: [], query: '' };
  }

  const queryEmbedding = await embedQuery(trimmed).catch(() => null);
  const hits = searchHybrid(trimmed, queryEmbedding, {
    tool: options.tool,
    limit: options.limit ?? 5
  });

  const textBlock = formatKnowledgeBlock(hits);
  return { textBlock, hits, query: trimmed };
}

