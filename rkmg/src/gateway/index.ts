import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../routing/router.js';
import { syncAllKnowledge, startKnowledgeWatcher } from '../knowledge/watcher.js';
import { createGatewayApp } from './server.js';
import { loadDotEnv } from './env.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/** Warn loudly if a tier points at a remote API but its key env var is unset —
 *  the strong tier would otherwise fail auth on the first request. */
function warnMissingTierKeys(config: ReturnType<typeof loadConfig>) {
  for (const [tierName, tier] of Object.entries(config.tiers)) {
    if (tier.api_key_env && !process.env[tier.api_key_env] && !tier.api_key) {
      console.warn(
        `[RKMG Init] ⚠ Tier "${tierName}" (${tier.name} @ ${tier.endpoint}) expects ` +
        `env var ${tier.api_key_env}, which is NOT set. Requests routed to this tier ` +
        `will fail auth. Set it in rkmg/.env or the shell before starting the gateway.`
      );
    }
  }
}

async function main() {
  console.log('====================================================');
  console.log('   RedLine Knowledge & Model Gateway (RKMG)');
  console.log('====================================================');

  if (loadDotEnv(path.resolve(__dirname, '../../.env'))) {
    console.log('[RKMG Init] Loaded .env');
  }

  const configPath = path.resolve(__dirname, '../../config/models.yaml');
  const config = loadConfig(configPath);
  console.log(`[RKMG Init] Configuration loaded from ${configPath}`);
  warnMissingTierKeys(config);

  // Step 1: Ingest and index all knowledge markdown files
  console.log('[RKMG Init] Running initial knowledge sync...');
  const { total, updated } = await syncAllKnowledge();
  console.log(`[RKMG Init] Knowledge sync complete: ${total} files scanned, ${updated} updated.`);

  // Step 2: Start background file watcher for live knowledge edits
  startKnowledgeWatcher();

  // Step 3: Start HTTP gateway server
  const app = createGatewayApp();
  const server = http.createServer(app);

  const port = process.env.PORT ? parseInt(process.env.PORT, 10) : config.server.port || 8000;
  const host = config.server.host || '127.0.0.1';

  server.listen(port, host, () => {
    console.log(`[RKMG Server] Gateway listening on http://${host}:${port}`);
    console.log(`[RKMG Server] Chat Completions: http://${host}:${port}/v1/chat/completions`);
    console.log(`[RKMG Server] Health probe:      http://${host}:${port}/health`);
    console.log(`[RKMG Server] Autolearn API:     http://${host}:${port}/v1/knowledge/autolearn`);
  });

  const shutdown = () => {
    console.log('\n[RKMG] Shutting down gracefully...');
    server.close(() => {
      console.log('[RKMG] Server closed.');
      process.exit(0);
    });
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err) => {
  console.error('[RKMG Fatal] Failed to start gateway:', err);
  process.exit(1);
});

