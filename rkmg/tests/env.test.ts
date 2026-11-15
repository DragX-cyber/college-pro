import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseDotEnv, loadDotEnv } from '../src/gateway/env.js';

test('parseDotEnv: basic key=value', () => {
  assert.deepStrictEqual(parseDotEnv('DEEPSEEK_API_KEY=sk-123'), { DEEPSEEK_API_KEY: 'sk-123' });
});

test('parseDotEnv: ignores blanks and # comments', () => {
  const out = parseDotEnv('\n# a comment\n   \nA=1\n#B=2\n');
  assert.deepStrictEqual(out, { A: '1' });
});

test('parseDotEnv: only the first = splits (values may contain =)', () => {
  assert.deepStrictEqual(parseDotEnv('TOKEN=abc=def==ghi'), { TOKEN: 'abc=def==ghi' });
});

test('parseDotEnv: strips surrounding single/double quotes and trims', () => {
  assert.deepStrictEqual(parseDotEnv('A = "spaced value" \nB=\'x\''), { A: 'spaced value', B: 'x' });
});

test('parseDotEnv: a lone quote is not stripped (needs a matching pair)', () => {
  assert.deepStrictEqual(parseDotEnv('A="'), { A: '"' });
});

test('parseDotEnv: lines without = and empty keys are skipped', () => {
  assert.deepStrictEqual(parseDotEnv('justtext\n=novalue\nK=v'), { K: 'v' });
});

test('parseDotEnv: CRLF line endings', () => {
  assert.deepStrictEqual(parseDotEnv('A=1\r\nB=2\r\n'), { A: '1', B: '2' });
});

test('loadDotEnv: missing file returns false and does nothing', () => {
  const missing = path.join(os.tmpdir(), 'rkmg-nope-' + Date.now() + '.env');
  assert.strictEqual(loadDotEnv(missing), false);
});

test('loadDotEnv: loads into process.env but never overrides an existing var', () => {
  const file = path.join(os.tmpdir(), 'rkmg-env-' + Date.now() + '.env');
  fs.writeFileSync(file, 'RKMG_NEW_VAR=fresh\nRKMG_PREEXISTING=fromfile\n');
  process.env.RKMG_PREEXISTING = 'fromenv';
  try {
    assert.strictEqual(loadDotEnv(file), true);
    assert.strictEqual(process.env.RKMG_NEW_VAR, 'fresh', 'a new var is loaded');
    assert.strictEqual(process.env.RKMG_PREEXISTING, 'fromenv', 'the real environment wins');
  } finally {
    delete process.env.RKMG_NEW_VAR;
    delete process.env.RKMG_PREEXISTING;
    fs.rmSync(file, { force: true });
  }
});
