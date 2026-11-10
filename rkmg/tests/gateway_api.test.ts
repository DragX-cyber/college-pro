import test from 'node:test';
import assert from 'node:assert';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createGatewayApp } from '../src/gateway/server.js';
import { loadConfig } from '../src/routing/router.js';
import { syncAllKnowledge } from '../src/knowledge/watcher.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

test('Gateway API: Endpoints /health, /v1/models, /v1/knowledge/autolearn', async () => {
  const configPath = path.resolve(__dirname, '../config/models.yaml');
  loadConfig(configPath);
  await syncAllKnowledge();

  const app = createGatewayApp();
  const server = http.createServer(app);

  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve());
  });

  const addr = server.address() as { port: number };
  const baseUrl = `http://127.0.0.1:${addr.port}`;

  try {
    // 1. Test /health
    const healthRes = await fetch(`${baseUrl}/health`);
    assert.strictEqual(healthRes.status, 200);
    const healthJson: any = await healthRes.json();
    assert.strictEqual(healthJson.status, 'ok');
    assert.strictEqual(healthJson.service, 'rkmg');
    assert.ok(healthJson.indexedKnowledgeCount > 0);

    // 2. Test /v1/models
    const modelsRes = await fetch(`${baseUrl}/v1/models`);
    assert.strictEqual(modelsRes.status, 200);
    const modelsJson: any = await modelsRes.json();
    assert.strictEqual(modelsJson.object, 'list');
    const modelIds = modelsJson.data.map((m: any) => m.id);
    assert.ok(modelIds.includes('redline-gateway'));

    // 3. Test /v1/knowledge/autolearn (Milestone P5)
    const autolearnRes = await fetch(`${baseUrl}/v1/knowledge/autolearn`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        tool: 'rustscan',
        title: 'rustscan ulimit requirement',
        content: 'rustscan requires --ulimit 5000 when running against large port ranges to prevent socket exhaustion',
        tags: ['rustscan', 'ulimit', 'performance']
      })
    });

    assert.strictEqual(autolearnRes.status, 200);
    const autolearnJson: any = await autolearnRes.json();
    assert.strictEqual(autolearnJson.ok, true);
    assert.ok(autolearnJson.file);

    // Verify file exists on disk in knowledge/autolearn/
    const createdFile = path.resolve(__dirname, `../knowledge/autolearn/${autolearnJson.file}`);
    assert.ok(fs.existsSync(createdFile), 'Autolearn file must exist on disk');

    // Clean up created file
    if (fs.existsSync(createdFile)) {
      fs.unlinkSync(createdFile);
    }
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

