import express, { Request, Response, NextFunction } from 'express';
import cors from 'cors';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { getConfig, routeRequest } from '../routing/router.js';
import {
  resolveSessionId,
  getOrComputeSessionKnowledge,
  injectKnowledgeIntoMessages,
  getSession
} from '../session/cache.js';
import { getAllEntries } from '../knowledge/index.js';
import { retrieveKnowledgeForTask } from '../knowledge/retrieve.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export function createGatewayApp(): express.Express {
  const app = express();
  app.use(cors({
    exposedHeaders: [
      'X-RKMG-Session',
      'X-RKMG-Tier',
      'X-RKMG-Turn',
      'X-RKMG-Cached',
      'X-RKMG-Checkpoint-Version',
      'X-RKMG-Injected-Knowledge'
    ]
  }));
  app.use(express.json({ limit: '10mb' }));

  // Serve test chat UI at root
  app.get(['/', '/test'], (req: Request, res: Response) => {
    const htmlPath = path.resolve(__dirname, '../../public/index.html');
    if (fs.existsSync(htmlPath)) {
      return res.sendFile(htmlPath);
    }
    const rootHtml = path.resolve(__dirname, '../../../test-chat.html');
    if (fs.existsSync(rootHtml)) {
      return res.sendFile(rootHtml);
    }
    res.redirect('/health');
  });

  // Request logger
  app.use((req: Request, res: Response, next: NextFunction) => {
    const start = Date.now();
    res.on('finish', () => {
      const duration = Date.now() - start;
      if (req.path !== '/health') {
        console.log(`[RKMG Gateway] ${req.method} ${req.path} -> ${res.statusCode} (${duration}ms)`);
      }
    });
    next();
  });

  /**
   * GET /health - Status of gateway, backends, and knowledge index
   */
  app.get('/health', async (req: Request, res: Response) => {
    const config = getConfig();
    const allEntries = getAllEntries();

    const tierStatus: Record<string, any> = {};
    for (const [tierName, tierConf] of Object.entries(config.tiers)) {
      tierStatus[tierName] = {
        name: tierConf.name,
        endpoint: tierConf.endpoint
      };
    }

    res.json({
      status: 'ok',
      service: 'rkmg',
      version: '1.0.0',
      indexedKnowledgeCount: allEntries.length,
      tiers: tierStatus
    });
  });

  /**
   * GET /v1/models - OpenAI-compatible model listing
   */
  app.get('/v1/models', (req: Request, res: Response) => {
    const config = getConfig();
    const modelList = [
      {
        id: 'redline-gateway',
        object: 'model',
        created: Math.floor(Date.now() / 1000),
        owned_by: 'rkmg'
      },
      ...Object.entries(config.tiers).map(([tierKey, tierConf]) => ({
        id: tierConf.name,
        object: 'model',
        created: Math.floor(Date.now() / 1000),
        owned_by: `rkmg-${tierKey}`
      }))
    ];

    res.json({
      object: 'list',
      data: modelList
    });
  });

  /**
   * GET /v1/knowledge/search - Direct search endpoint for knowledge testing & inspection
   */
  app.get('/v1/knowledge/search', async (req: Request, res: Response) => {
    try {
      const query = String(req.query.q || '').trim();
      const tool = req.query.tool ? String(req.query.tool).trim() : null;
      const limit = req.query.limit ? parseInt(String(req.query.limit), 10) : 5;
      const { textBlock, hits } = await retrieveKnowledgeForTask(query, { tool, limit });
      return res.json({
        query,
        count: hits.length,
        hits: hits.map((h) => ({
          id: h.entry.id,
          source: h.entry.source,
          kind: h.entry.kind,
          tool: h.entry.tool,
          title: h.entry.title,
          tags: h.entry.tags,
          content: h.entry.content,
          score: h.score,
          matchType: h.matchType
        })),
        textBlock
      });
    } catch (e: any) {
      return res.status(500).json({ error: String(e?.message || e) });
    }
  });

  /**
   * POST /v1/chat/completions - The core OpenAI-compatible gateway endpoint
   */
  app.post('/v1/chat/completions', async (req: Request, res: Response) => {
    try {
      const {
        model,
        messages,
        temperature,
        max_tokens,
        stream = false
      } = req.body;

      if (!Array.isArray(messages) || messages.length === 0) {
        return res.status(400).json({
          error: {
            message: 'Invalid request: "messages" must be a non-empty array',
            type: 'invalid_request_error',
            param: 'messages',
            code: null
          }
        });
      }

      // 1. Session resolution and Prefix-Stability Invariant
      const sessionId = resolveSessionId(req.headers as any, messages);
      const isCheckpoint =
        req.headers['x-redline-checkpoint'] === 'true' ||
        req.body.checkpoint === true;

      // Extract task context for retrieval on turn 1 or explicit checkpoint
      const userPrompt =
        [...messages].reverse().find((m) => m.role === 'user')?.content || '';
      const systemPrompt =
        messages.find((m) => m.role === 'system')?.content || '';
      const queryContext = `${userPrompt}\n${systemPrompt.slice(0, 300)}`.trim();

      const { knowledgeBlock, isTurn1, checkpointVersion } =
        await getOrComputeSessionKnowledge(sessionId, queryContext, isCheckpoint);

      // Invariant: stable prompt prefix reconstruction
      const preparedMessages = injectKnowledgeIntoMessages(messages, knowledgeBlock);

      // 2. Model Routing Layer
      const route = routeRequest(preparedMessages, req.headers as any);
      const session = getSession(sessionId);
      if (session) {
        session.lastTier = route.selectedTier;
      }

      // Metadata headers for RedLine and debugging
      res.setHeader('X-RKMG-Session', sessionId);
      res.setHeader('X-RKMG-Tier', route.selectedTier);
      res.setHeader('X-RKMG-Turn', session?.turnCount ?? 1);
      res.setHeader('X-RKMG-Cached', (!isTurn1 && !isCheckpoint).toString());
      res.setHeader('X-RKMG-Checkpoint-Version', checkpointVersion.toString());
      if (knowledgeBlock) {
        res.setHeader('X-RKMG-Injected-Knowledge', Buffer.from(knowledgeBlock).toString('base64'));
      }

      // Dry run / knowledge preview mode
      const isDryRun = req.headers['x-rkmg-dry-run'] === 'true' || req.body.dryRun === true;
      if (isDryRun) {
        const rulesCount = (knowledgeBlock.match(/^- \[/gm) || []).length;
        return res.json({
          id: `chatcmpl-dryrun-${Date.now()}`,
          object: 'chat.completion',
          created: Math.floor(Date.now() / 1000),
          model: 'rkmg-knowledge-preview',
          choices: [
            {
              index: 0,
              message: {
                role: 'assistant',
                content: JSON.stringify({
                  thought: `RKMG retrieved and injected ${rulesCount} rules into the system prompt for target context. (Dry-run test mode)`,
                  action: {
                    tool: 'get_knowledge',
                    query: userPrompt,
                    rulesInjected: rulesCount
                  }
                }, null, 2)
              },
              finish_reason: 'stop'
            }
          ],
          injectedKnowledge: knowledgeBlock
        });
      }

      // 3. Inference Backend Invocation with GBNF Grammar Constraint
      if (stream) {
        res.setHeader('Content-Type', 'text/event-stream');
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('Connection', 'keep-alive');

        try {
          for await (const chunk of route.backend.streamComplete({
            tier: route.backend.getConfig(),
            messages: preparedMessages,
            temperature,
            maxTokens: max_tokens,
            stream: true,
            grammarConstraint: true
          })) {
            res.write(`${chunk}\n\n`);
          }
          res.write('data: [DONE]\n\n');
          res.end();
        } catch (streamErr: any) {
          console.error('[RKMG Gateway] Streaming error:', streamErr);
          res.write(`data: {"error": "${String(streamErr?.message || streamErr)}"}\n\n`);
          res.end();
        }
      } else {
        const result = await route.backend.complete({
          tier: route.backend.getConfig(),
          messages: preparedMessages,
          temperature,
          maxTokens: max_tokens,
          stream: false,
          grammarConstraint: true
        });

        // Strictly OpenAI-compatible response shape
        return res.json({
          id: result.id,
          object: 'chat.completion',
          created: Math.floor(Date.now() / 1000),
          model: model || route.backend.getConfig().name,
          choices: [
            {
              index: 0,
              message: {
                role: 'assistant',
                content: result.content
              },
              finish_reason: result.finishReason
            }
          ],
          usage: result.usage
        });
      }
    } catch (err: any) {
      console.error('[RKMG Gateway] Completion handler error:', err);
      return res.status(500).json({
        error: {
          message: String(err?.message || err),
          type: 'gateway_error',
          param: null,
          code: 'internal_error'
        }
      });
    }
  });

  /**
   * POST /v1/knowledge/autolearn & /api/knowledge/autolearn
   * FR-9 & Milestone P5: Auto-learned mistake ingestion.
   * Writes a new markdown file into knowledge/autolearn/.
   * The file watcher reacts immediately to hash-diff, embed, and index.
   */
  const handleAutolearn = async (req: Request, res: Response) => {
    try {
      const { tool, title, content, tags = [], kind = 'mistake' } = req.body;

      if (!content || !title) {
        return res.status(400).json({
          error: 'Missing required fields: "title" and "content"'
        });
      }

      const autolearnDir = path.resolve(__dirname, '../../knowledge/autolearn');
      if (!fs.existsSync(autolearnDir)) {
        fs.mkdirSync(autolearnDir, { recursive: true });
      }

      // Generate a clean safe slug filename
      const safeSlug = title
        .toLowerCase()
        .replace(/[^a-z0-9_-]/g, '-')
        .replace(/-+/g, '-')
        .slice(0, 50);
      const uniqueSuffix = crypto.randomBytes(3).toString('hex');
      const filename = `${safeSlug}-${uniqueSuffix}.md`;
      const filePath = path.join(autolearnDir, filename);

      const tagList = Array.isArray(tags) ? tags : [tags].filter(Boolean);
      if (tool && !tagList.includes(tool.toLowerCase())) {
        tagList.push(tool.toLowerCase());
      }

      const markdownContent = `---
id: ${path.basename(filename, '.md')}
source: autolearn
kind: ${kind}
tool: ${tool || 'generic'}
title: ${title.replace(/\n/g, ' ').trim()}
tags: [${tagList.map((t: string) => `"${t}"`).join(', ')}]
---
${content.trim()}
`;

      fs.writeFileSync(filePath, markdownContent, 'utf-8');
      console.log(`[RKMG Autolearn] Wrote new mistake entry: ${filename}`);

      return res.json({
        ok: true,
        file: filename,
        id: path.basename(filename, '.md')
      });
    } catch (e: any) {
      console.error('[RKMG Autolearn] Failed to write autolearn entry:', e);
      return res.status(500).json({ error: String(e?.message || e) });
    }
  };

  app.post('/v1/knowledge/autolearn', handleAutolearn);
  app.post('/api/knowledge/autolearn', handleAutolearn);

  return app;
}

