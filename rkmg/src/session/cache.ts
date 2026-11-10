import crypto from 'node:crypto';
import { retrieveKnowledgeForTask } from '../knowledge/retrieve.js';
import { ChatMessage } from '../inference/backend.js';

export interface SessionData {
  sessionId: string;
  injectedKnowledge: string;
  query: string;
  checkpointVersion: number;
  turnCount: number;
  createdAt: number;
  lastAccessedAt: number;
  lastTier?: string;
}

const sessionStore = new Map<string, SessionData>();

/**
 * Clean up sessions inactive for more than 24 hours.
 */
const SESSION_TTL_MS = 24 * 60 * 60 * 1000;

export function cleanupExpiredSessions(): void {
  const now = Date.now();
  for (const [id, s] of sessionStore.entries()) {
    if (now - s.lastAccessedAt > SESSION_TTL_MS) {
      sessionStore.delete(id);
    }
  }
}

/**
 * Resolves a stable session identifier from:
 * 1. Explicit `X-RedLine-Session` header
 * 2. Active engagement ID in system prompt (`ACTIVE ENGAGEMENT: <eid>`)
 * 3. Consistent SHA-256 hash of system prompt + initial user message
 */
export function resolveSessionId(
  headers: Record<string, string | string[] | undefined>,
  messages: ChatMessage[]
): string {
  // 1. Header takes precedence
  const headerSession = (headers['x-redline-session'] as string)?.trim();
  if (headerSession) return headerSession;

  // 2. Look for engagement in system prompt
  const systemPrompt = messages.find((m) => m.role === 'system')?.content || '';
  const match = systemPrompt.match(/## ACTIVE ENGAGEMENT:\s*([^\r\n]+)/i);
  if (match && match[1]) {
    return match[1].trim();
  }

  // 3. Look for target line
  const targetMatch = systemPrompt.match(/target:\s*([^\r\n]+)/i);
  if (targetMatch && targetMatch[1]) {
    const target = targetMatch[1].trim();
    // Stable hash of target + first user prompt
    const firstUser = messages.find((m) => m.role === 'user')?.content || '';
    return `session_${crypto.createHash('sha256').update(`${target}_${firstUser.slice(0, 50)}`).digest('hex').slice(0, 16)}`;
  }

  // 4. Fallback hash of system prompt
  if (systemPrompt) {
    return `session_${crypto.createHash('sha256').update(systemPrompt.slice(0, 200)).digest('hex').slice(0, 16)}`;
  }

  return 'session_default';
}

/**
 * Get session record if present.
 */
export function getSession(sessionId: string): SessionData | undefined {
  const session = sessionStore.get(sessionId);
  if (session) {
    session.lastAccessedAt = Date.now();
  }
  return session;
}

/**
 * Core Invariant Enforcer:
 * Injects knowledge once per session or explicit checkpoint.
 * On turn 2+, returns the exact same knowledge block in O(1) without re-embedding.
 */
export async function getOrComputeSessionKnowledge(
  sessionId: string,
  query: string,
  isCheckpoint: boolean = false
): Promise<{ knowledgeBlock: string; isTurn1: boolean; checkpointVersion: number }> {
  cleanupExpiredSessions();

  const existing = sessionStore.get(sessionId);

  // Turn 2+ hot path: return cached knowledge block instantly in O(1)
  if (existing && !isCheckpoint) {
    existing.turnCount += 1;
    existing.lastAccessedAt = Date.now();
    return {
      knowledgeBlock: existing.injectedKnowledge,
      isTurn1: false,
      checkpointVersion: existing.checkpointVersion
    };
  }

  // Turn 1 or explicit checkpoint: perform retrieval
  const { textBlock } = await retrieveKnowledgeForTask(query);

  const checkpointVersion = existing ? existing.checkpointVersion + 1 : 1;
  const newSession: SessionData = {
    sessionId,
    injectedKnowledge: textBlock,
    query,
    checkpointVersion,
    turnCount: existing ? existing.turnCount + 1 : 1,
    createdAt: existing ? existing.createdAt : Date.now(),
    lastAccessedAt: Date.now()
  };

  sessionStore.set(sessionId, newSession);

  return {
    knowledgeBlock: textBlock,
    isTurn1: !existing,
    checkpointVersion
  };
}

/**
 * Replaces or injects the stable knowledge block into the system prompt.
 * Guaranteed to keep prompt prefix identical across turns for KV-cache reuse.
 */
export function injectKnowledgeIntoMessages(
  messages: ChatMessage[],
  knowledgeBlock: string
): ChatMessage[] {
  if (!knowledgeBlock.trim()) return messages;

  const result = [...messages];
  const systemIndex = result.findIndex((m) => m.role === 'system');

  if (systemIndex >= 0) {
    const current = result[systemIndex].content;

    // Check if RKMG knowledge block is already there
    if (current.includes('## KNOWLEDGE (RKMG)')) {
      return result; // already has it
    }

    // Replace any existing legacy RedLine knowledge block if present, or append
    let modified = current;
    if (modified.includes('## KNOWLEDGE - planning rules')) {
      // Strip old per-turn block and replace with stable RKMG block
      modified = modified.replace(/## KNOWLEDGE - planning rules[\s\S]*?(?=\n## |$)/, knowledgeBlock);
    } else {
      // Append right before tool board or active engagement
      const insertMarker = '\n## YOUR TOOLS';
      if (modified.includes(insertMarker)) {
        modified = modified.replace(insertMarker, `\n${knowledgeBlock}\n${insertMarker}`);
      } else {
        modified = `${modified}\n\n${knowledgeBlock}`;
      }
    }

    result[systemIndex] = {
      role: 'system',
      content: modified
    };
  } else {
    // No system prompt; prepend one
    result.unshift({
      role: 'system',
      content: knowledgeBlock
    });
  }

  return result;
}

export function resetAllSessions(): void {
  sessionStore.clear();
}

