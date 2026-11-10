import { getConfig } from '../routing/router.js';

export const DOC_PREFIX = 'search_document: ';
export const QUERY_PREFIX = 'search_query: ';

/**
 * Call local llama-server --embedding to get vector embeddings.
 * Returns null if embedding server is unreachable or fails (triggering keyword fallback).
 */
export async function embedTexts(
  texts: string[],
  prefix: string = DOC_PREFIX
): Promise<number[][] | null> {
  if (!texts.length) return [];

  const config = getConfig();
  const base = config.embedding.endpoint.replace(/\/$/, '');
  const model = config.embedding.model || 'nomic-embed-text';
  const batchSize = config.embedding.batch_size || 16;
  const timeoutMs = config.embedding.timeout_ms || 15000;

  const prepared = texts.map((t) => `${prefix}${t}`);
  const out: number[][] = [];

  for (let i = 0; i < prepared.length; i += batchSize) {
    const slice = prepared.slice(i, i + batchSize);
    try {
      const res = await fetch(`${base}/v1/embeddings`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model, input: slice }),
        signal: AbortSignal.timeout(timeoutMs)
      });

      if (!res.ok) {
        // Try fallback endpoint /embeddings
        const fallbackRes = await fetch(`${base}/embeddings`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ model, input: slice }),
          signal: AbortSignal.timeout(timeoutMs)
        });

        if (!fallbackRes.ok) {
          console.warn(`[RKMG Embed] Embedding server returned status ${fallbackRes.status}`);
          return null;
        }

        const json: any = await fallbackRes.json();
        const data = json?.data ?? [];
        for (const item of data) {
          if (Array.isArray(item.embedding)) {
            out.push(item.embedding);
          } else {
            return null;
          }
        }
      } else {
        const json: any = await res.json();
        const data = json?.data ?? [];
        for (const item of data) {
          if (Array.isArray(item.embedding)) {
            out.push(item.embedding);
          } else {
            return null;
          }
        }
      }
    } catch (err: any) {
      console.warn(`[RKMG Embed] Embedding server connection failure: ${err?.message || err}`);
      return null;
    }
  }

  return out.length === texts.length ? out : null;
}

/**
 * Embed a single query string for semantic search.
 */
export async function embedQuery(query: string): Promise<number[] | null> {
  const result = await embedTexts([query], QUERY_PREFIX);
  return result && result.length > 0 ? result[0] : null;
}

