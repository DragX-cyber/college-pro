import test from 'node:test';
import assert from 'node:assert';
import { InferenceBackend, BackendTierConfig } from '../src/inference/backend.js';

// A minimal OpenAI-style success body the backend can parse.
function okResponse(): Response {
  return new Response(
    JSON.stringify({
      id: 'chatcmpl-test',
      choices: [
        { message: { content: '{"thought":"t","action":{"tool":"final","text":"ok"}}' }, finish_reason: 'stop' }
      ],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 }
    }),
    { status: 200, headers: { 'content-type': 'application/json' } }
  );
}

// Run one complete() call against a stubbed fetch and capture the outgoing request.
async function capture(config: BackendTierConfig, reqTemp?: number) {
  const cap: { url?: string; body?: any; headers?: Record<string, string> } = {};
  const orig = globalThis.fetch;
  globalThis.fetch = (async (url: any, init: any) => {
    cap.url = String(url);
    cap.body = JSON.parse(init.body);
    cap.headers = init.headers;
    return okResponse();
  }) as any;
  try {
    const backend = new InferenceBackend(config);
    await backend.complete({ tier: config, messages: [{ role: 'user', content: 'hi' }], temperature: reqTemp });
  } finally {
    globalThis.fetch = orig;
  }
  return cap;
}

const local: BackendTierConfig = { name: 'local-9b', endpoint: 'http://127.0.0.1:8080', temperature: 0.2 };

test('backend: local schema tier sends the JSON schema and no Authorization', async () => {
  const cap = await capture({ ...local, structured_output: 'schema' });
  assert.strictEqual(cap.body.response_format.type, 'json_object');
  assert.ok(cap.body.response_format.schema, 'schema present for a local schema tier');
  assert.ok(!cap.headers!['Authorization'], 'no Authorization header for a local tier');
});

test('backend: local json tier uses json mode without the schema', async () => {
  const cap = await capture({ ...local, structured_output: 'json' });
  assert.strictEqual(cap.body.response_format.type, 'json_object');
  assert.strictEqual(cap.body.response_format.schema, undefined);
});

test('backend: structured_output "off" sends no response_format at all', async () => {
  const cap = await capture({ ...local, structured_output: 'off' });
  assert.strictEqual(cap.body.response_format, undefined);
});

test('backend: remote tier sends Bearer auth and json mode even if schema was requested', async () => {
  process.env.TEST_RKMG_KEY = 'sk-abc';
  try {
    const cap = await capture({
      name: 'deepseek-chat', endpoint: 'https://api.deepseek.com',
      api_key_env: 'TEST_RKMG_KEY', structured_output: 'schema', temperature: 0.3
    });
    assert.strictEqual(cap.headers!['Authorization'], 'Bearer sk-abc');
    assert.strictEqual(cap.body.response_format.type, 'json_object');
    assert.strictEqual(cap.body.response_format.schema, undefined, 'the llama-server schema must never go to a remote API');
  } finally {
    delete process.env.TEST_RKMG_KEY;
  }
});

test('backend: tier temperature is authoritative over the request temperature', async () => {
  const cap = await capture({ ...local, temperature: 0.15 }, 0.9);
  assert.strictEqual(cap.body.temperature, 0.15);
});

test('backend: request temperature is used only when the tier defines none', async () => {
  const cap = await capture({ name: 'x', endpoint: 'http://127.0.0.1:8080' }, 0.7);
  assert.strictEqual(cap.body.temperature, 0.7);
});

test('backend: temperature 0 on the tier is respected (nullish, not falsy)', async () => {
  const cap = await capture({ name: 'x', endpoint: 'http://127.0.0.1:8080', temperature: 0 }, 0.9);
  assert.strictEqual(cap.body.temperature, 0);
});

test('backend: needsKeyButMissing only when an api_key_env is set and unresolved', () => {
  assert.strictEqual(new InferenceBackend({ name: 'a', endpoint: 'x' }).needsKeyButMissing(), false);
  assert.strictEqual(new InferenceBackend({ name: 'a', endpoint: 'x', api_key: 'literal' }).needsKeyButMissing(), false);
  assert.strictEqual(new InferenceBackend({ name: 'a', endpoint: 'x', api_key_env: 'RKMG_DEFINITELY_UNSET' }).needsKeyButMissing(), true);

  process.env.RKMG_SET = 'k';
  try {
    assert.strictEqual(new InferenceBackend({ name: 'a', endpoint: 'x', api_key_env: 'RKMG_SET' }).needsKeyButMissing(), false);
  } finally {
    delete process.env.RKMG_SET;
  }

  process.env.RKMG_WS = '   ';
  try {
    assert.strictEqual(
      new InferenceBackend({ name: 'a', endpoint: 'x', api_key_env: 'RKMG_WS' }).needsKeyButMissing(),
      true,
      'a whitespace-only key counts as missing'
    );
  } finally {
    delete process.env.RKMG_WS;
  }
});
