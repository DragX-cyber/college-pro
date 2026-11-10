import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export interface StoredKnowledgeEntry {
  id: string;
  source: 'seed' | 'operator' | 'autolearn';
  kind: string;
  tool: string | null;
  title: string;
  content: string;
  tags: string[];
  content_hash: string;
  embedding?: number[] | null;
  updated_at: number;
}

export interface SearchHit {
  entry: StoredKnowledgeEntry;
  score: number;
  matchType: 'vector' | 'keyword' | 'hybrid';
}

let dbInstance: DatabaseSync | null = null;

function getDb(): DatabaseSync {
  if (dbInstance) return dbInstance;

  const dataDir = path.resolve(__dirname, '../../data');
  if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
  }

  const dbPath = path.join(dataDir, 'vector_index.db');
  dbInstance = new DatabaseSync(dbPath);

  // Enable WAL mode and busy timeout for concurrent access resilience
  dbInstance.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA busy_timeout = 5000;
  `);

  // Initialize schema
  dbInstance.exec(`
    CREATE TABLE IF NOT EXISTS knowledge_index (
      id TEXT PRIMARY KEY,
      source TEXT NOT NULL,
      kind TEXT NOT NULL,
      tool TEXT,
      title TEXT NOT NULL,
      content TEXT NOT NULL,
      tags TEXT NOT NULL,
      content_hash TEXT NOT NULL,
      embedding TEXT,
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_k_hash ON knowledge_index (content_hash);
    CREATE INDEX IF NOT EXISTS idx_k_source ON knowledge_index (source);
    CREATE INDEX IF NOT EXISTS idx_k_tool ON knowledge_index (tool);
  `);

  return dbInstance;
}

/**
 * Compute cosine similarity between two float vectors.
 */
export function cosineSimilarity(a: number[], b: number[]): number {
  if (!a || !b || a.length !== b.length || a.length === 0) return 0;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}

/**
 * Tokenize a string into alphanumeric query terms.
 */
function tokenize(text: string): string[] {
  return (text || '')
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 1);
}

/**
 * Upsert entry into the derived index.
 * Idempotent: checks content_hash and updates existing rows by ID.
 */
export function upsertEntry(entry: StoredKnowledgeEntry): void {
  const db = getDb();
  const stmt = db.prepare(`
    INSERT INTO knowledge_index (id, source, kind, tool, title, content, tags, content_hash, embedding, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      source = excluded.source,
      kind = excluded.kind,
      tool = excluded.tool,
      title = excluded.title,
      content = excluded.content,
      tags = excluded.tags,
      content_hash = excluded.content_hash,
      embedding = excluded.embedding,
      updated_at = excluded.updated_at;
  `);

  const embeddingJson = entry.embedding && entry.embedding.length > 0 ? JSON.stringify(entry.embedding) : null;
  stmt.run(
    entry.id,
    entry.source,
    entry.kind,
    entry.tool || null,
    entry.title,
    entry.content,
    JSON.stringify(entry.tags || []),
    entry.content_hash,
    embeddingJson,
    entry.updated_at || Date.now()
  );
}

/**
 * Remove an entry from the derived index by ID (used when a file is deleted).
 */
export function deleteEntry(id: string): void {
  const db = getDb();
  const stmt = db.prepare('DELETE FROM knowledge_index WHERE id = ?');
  stmt.run(id);
}

/**
 * Retrieve content hash for a given entry ID to determine if re-embedding is needed.
 */
export function getContentHash(id: string): string | null {
  const db = getDb();
  const stmt = db.prepare('SELECT content_hash FROM knowledge_index WHERE id = ?');
  const row = stmt.get(id) as { content_hash: string } | undefined;
  return row ? row.content_hash : null;
}

/**
 * Retrieve a single entry by ID.
 */
export function getEntryById(id: string): StoredKnowledgeEntry | null {
  const db = getDb();
  const stmt = db.prepare('SELECT * FROM knowledge_index WHERE id = ?');
  const row = stmt.get(id) as any;
  if (!row) return null;
  return {
    id: row.id,
    source: row.source,
    kind: row.kind,
    tool: row.tool,
    title: row.title,
    content: row.content,
    tags: JSON.parse(row.tags || '[]'),
    content_hash: row.content_hash,
    embedding: row.embedding ? JSON.parse(row.embedding) : null,
    updated_at: row.updated_at
  };
}

/**
 * Retrieve all active entries from the derived index.
 */
export function getAllEntries(): StoredKnowledgeEntry[] {
  const db = getDb();
  const stmt = db.prepare('SELECT * FROM knowledge_index ORDER BY updated_at DESC');
  const rows = stmt.all() as any[];
  return rows.map((row) => ({
    id: row.id,
    source: row.source,
    kind: row.kind,
    tool: row.tool,
    title: row.title,
    content: row.content,
    tags: JSON.parse(row.tags || '[]'),
    content_hash: row.content_hash,
    embedding: row.embedding ? JSON.parse(row.embedding) : null,
    updated_at: row.updated_at
  }));
}

/**
 * Keyword-based scoring (title: 4x, tags: 3x, tool: 3x, content: 1x).
 * Used when vector search is unavailable or as part of hybrid ranking.
 */
export function searchKeyword(
  query: string,
  options: { tool?: string | null; limit?: number } = {}
): SearchHit[] {
  const { tool, limit = 5 } = options;
  const entries = getAllEntries();
  const queryTokens = tokenize(query);
  if (!queryTokens.length) return [];

  const toolLower = tool ? tool.toLowerCase().trim() : null;
  const scored: SearchHit[] = [];

  for (const entry of entries) {
    if (toolLower && entry.tool && entry.tool.toLowerCase() !== toolLower) {
      // If tool is specified, demote or filter other tool-specific entries
      continue;
    }

    const titleTokens = tokenize(entry.title);
    const contentTokens = tokenize(entry.content);
    const tagTokens = entry.tags.map((t) => t.toLowerCase());
    const entryTool = (entry.tool || '').toLowerCase();

    let score = 0;
    for (const q of queryTokens) {
      if (titleTokens.includes(q)) score += 4;
      if (tagTokens.includes(q)) score += 3;
      if (entryTool === q) score += 3;
      if (contentTokens.includes(q)) score += 1;
    }

    if (toolLower && entryTool === toolLower) {
      score += 5; // strong affinity for matching tool
    }

    if (score > 0) {
      scored.push({ entry, score, matchType: 'keyword' });
    }
  }

  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, limit);
}

/**
 * Hybrid semantic and keyword search.
 */
export function searchHybrid(
  query: string,
  queryEmbedding: number[] | null,
  options: { tool?: string | null; limit?: number } = {}
): SearchHit[] {
  const { tool, limit = 5 } = options;
  const entries = getAllEntries();

  // If no embeddings available, fall back cleanly to keyword search
  if (!queryEmbedding) {
    return searchKeyword(query, options);
  }

  const queryTokens = tokenize(query);
  const toolLower = tool ? tool.toLowerCase().trim() : null;
  const results: SearchHit[] = [];

  for (const entry of entries) {
    if (toolLower && entry.tool && entry.tool.toLowerCase() !== toolLower) {
      continue;
    }

    let vectorScore = 0;
    if (entry.embedding && entry.embedding.length > 0) {
      vectorScore = cosineSimilarity(queryEmbedding, entry.embedding);
    }

    // Keyword score normalized
    let keywordScore = 0;
    const titleTokens = tokenize(entry.title);
    const contentTokens = tokenize(entry.content);
    const tagTokens = entry.tags.map((t) => t.toLowerCase());
    const entryTool = (entry.tool || '').toLowerCase();

    for (const q of queryTokens) {
      if (titleTokens.includes(q)) keywordScore += 4;
      if (tagTokens.includes(q)) keywordScore += 3;
      if (entryTool === q) keywordScore += 3;
      if (contentTokens.includes(q)) keywordScore += 1;
    }

    // Blend: normalized keyword + vector cosine similarity
    // Cosine similarity ranges [-1, 1], typically [0.3, 0.9] for relevant hits
    const combinedScore = (vectorScore > 0 ? vectorScore * 10 : 0) + keywordScore;

    if (combinedScore > 1.5 || vectorScore > 0.6) {
      results.push({
        entry,
        score: combinedScore,
        matchType: vectorScore > 0 && keywordScore > 0 ? 'hybrid' : vectorScore > 0 ? 'vector' : 'keyword'
      });
    }
  }

  results.sort((a, b) => b.score - a.score);
  return results.slice(0, limit);
}
