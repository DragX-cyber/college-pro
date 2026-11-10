import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';
import chokidar, { FSWatcher } from 'chokidar';
import { embedTexts } from './embed.js';
import { upsertEntry, deleteEntry, getContentHash, StoredKnowledgeEntry } from './index.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export function calculateContentHash(content: string): string {
  return crypto.createHash('sha256').update(content.trim()).digest('hex');
}

export interface ParsedMarkdownKnowledge {
  id: string;
  source: 'seed' | 'operator' | 'autolearn';
  kind: string;
  tool: string | null;
  title: string;
  tags: string[];
  content: string;
  rawText: string;
}

/**
 * Parses a knowledge Markdown file with YAML frontmatter.
 */
export function parseKnowledgeFile(filePath: string): ParsedMarkdownKnowledge | null {
  try {
    if (!fs.existsSync(filePath)) return null;
    const raw = fs.readFileSync(filePath, 'utf-8');

    // Parse frontmatter between --- and ---
    const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/);
    let frontmatter: Record<string, any> = {};
    let contentBody = raw.trim();

    if (match) {
      frontmatter = (yaml.load(match[1]) as Record<string, any>) || {};
      contentBody = match[2].trim();
    }

    const fileName = path.basename(filePath, path.extname(filePath));
    const parentDir = path.basename(path.dirname(filePath)) as 'seed' | 'operator' | 'autolearn';

    const id = String(frontmatter.id || fileName).trim();
    const source = (['seed', 'operator', 'autolearn'].includes(frontmatter.source)
      ? frontmatter.source
      : ['seed', 'operator', 'autolearn'].includes(parentDir)
      ? parentDir
      : 'operator') as 'seed' | 'operator' | 'autolearn';

    const kind = String(frontmatter.kind || 'tool_usage').trim();
    const tool = frontmatter.tool ? String(frontmatter.tool).trim() : null;
    const title = String(frontmatter.title || fileName.replace(/[-_]/g, ' ')).trim();

    let tags: string[] = [];
    if (Array.isArray(frontmatter.tags)) {
      tags = frontmatter.tags.map((t) => String(t).trim().toLowerCase());
    } else if (typeof frontmatter.tags === 'string') {
      tags = frontmatter.tags.split(',').map((t) => t.trim().toLowerCase());
    }

    return {
      id,
      source,
      kind,
      tool,
      title,
      tags,
      content: contentBody,
      rawText: raw
    };
  } catch (err: any) {
    console.error(`[RKMG Watcher] Failed to parse ${filePath}:`, err?.message || err);
    return null;
  }
}

/**
 * Sync a single markdown file into the vector index.
 * Hash-diff: only re-embeds if content hash changed.
 * Returns true if embedded/updated, false if skipped (unchanged).
 */
export async function syncKnowledgeFile(filePath: string): Promise<boolean> {
  const parsed = parseKnowledgeFile(filePath);
  if (!parsed) return false;

  const textForHash = `${parsed.id}\n${parsed.kind}\n${parsed.tool || ''}\n${parsed.title}\n${parsed.tags.join(',')}\n${parsed.content}`;
  const currentHash = calculateContentHash(textForHash);
  const existingHash = getContentHash(parsed.id);

  if (existingHash === currentHash) {
    // Content unchanged — invariant: never re-embed or duplicate unchanged rows
    return false;
  }

  // Text to embed: combination of tool, title, tags, and content
  const embedPayload = `[${parsed.kind}${parsed.tool ? `:${parsed.tool}` : ''}] ${parsed.title}: ${parsed.content}`;
  const embeddings = await embedTexts([embedPayload]).catch(() => null);

  const entry: StoredKnowledgeEntry = {
    id: parsed.id,
    source: parsed.source,
    kind: parsed.kind,
    tool: parsed.tool,
    title: parsed.title,
    content: parsed.content,
    tags: parsed.tags,
    content_hash: currentHash,
    embedding: embeddings && embeddings.length > 0 ? embeddings[0] : null,
    updated_at: Date.now()
  };

  upsertEntry(entry);
  console.log(`[RKMG Watcher] Synced ${parsed.id} (${parsed.source}) [re-embedded: ${!!entry.embedding}]`);
  return true;
}

/**
 * Handle deletion of a markdown knowledge file.
 */
export function removeKnowledgeFile(filePath: string): void {
  const fileName = path.basename(filePath, path.extname(filePath));
  // In our convention, id is default file basename or we check by id
  deleteEntry(fileName);
  console.log(`[RKMG Watcher] Removed ${fileName} from index`);
}

/**
 * Initial sync scan of all knowledge directories on startup.
 */
export async function syncAllKnowledge(baseKnowledgeDir?: string): Promise<{ total: number; updated: number }> {
  const rootDir = baseKnowledgeDir || path.resolve(__dirname, '../../knowledge');
  const subDirs = ['seed', 'operator', 'autolearn'];
  let total = 0;
  let updated = 0;

  for (const sub of subDirs) {
    const dir = path.join(rootDir, sub);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    const files = fs.readdirSync(dir).filter((f) => f.endsWith('.md') || f.endsWith('.markdown'));
    for (const f of files) {
      total++;
      const fullPath = path.join(dir, f);
      const wasUpdated = await syncKnowledgeFile(fullPath);
      if (wasUpdated) updated++;
    }
  }

  return { total, updated };
}

/**
 * Start the file watcher for knowledge files.
 */
export function startKnowledgeWatcher(baseKnowledgeDir?: string): FSWatcher {
  const rootDir = baseKnowledgeDir || path.resolve(__dirname, '../../knowledge');
  const watcher = chokidar.watch(`${rootDir}/**/*.md`, {
    persistent: true,
    ignoreInitial: true,
    awaitWriteFinish: {
      stabilityThreshold: 300,
      pollInterval: 100
    }
  });

  watcher.on('add', (filePath) => {
    void syncKnowledgeFile(filePath);
  });

  watcher.on('change', (filePath) => {
    void syncKnowledgeFile(filePath);
  });

  watcher.on('unlink', (filePath) => {
    removeKnowledgeFile(filePath);
  });

  console.log(`[RKMG Watcher] Watching knowledge directories in: ${rootDir}`);
  return watcher;
}

