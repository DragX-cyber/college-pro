import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { syncKnowledgeFile, parseKnowledgeFile, removeKnowledgeFile } from '../src/knowledge/watcher.js';
import { getEntryById, getContentHash } from '../src/knowledge/index.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

test('Hash-Diff Sync Logic: file changed vs. unchanged', async () => {
  const tempDir = path.resolve(__dirname, '../data/test_sync');
  if (!fs.existsSync(tempDir)) {
    fs.mkdirSync(tempDir, { recursive: true });
  }

  const testFile = path.join(tempDir, 'test-hash-entry.md');
  const initialContent = `---
id: test-hash-entry
source: operator
kind: tool_usage
tool: curl
title: "curl header inspection"
tags: ["curl", "headers"]
---
curl -I -s http://target.local - inspect HTTP response headers quickly.
`;

  fs.writeFileSync(testFile, initialContent, 'utf-8');

  // 1. Initial sync should ingest and return true
  const firstSync = await syncKnowledgeFile(testFile);
  assert.strictEqual(firstSync, true, 'First sync should ingest entry');

  const entry = getEntryById('test-hash-entry');
  assert.ok(entry, 'Entry should exist in index');
  assert.strictEqual(entry.tool, 'curl');

  const hash1 = getContentHash('test-hash-entry');
  assert.ok(hash1, 'Content hash should be stored');

  // 2. Second sync on unchanged file should skip (return false)
  const secondSync = await syncKnowledgeFile(testFile);
  assert.strictEqual(secondSync, false, 'Second sync on unchanged file must be skipped');

  // 3. Modify content of the file
  const modifiedContent = `---
id: test-hash-entry
source: operator
kind: tool_usage
tool: curl
title: "curl header inspection"
tags: ["curl", "headers", "redirects"]
---
curl -IL -s http://target.local - follow redirects while inspecting headers.
`;

  fs.writeFileSync(testFile, modifiedContent, 'utf-8');

  const thirdSync = await syncKnowledgeFile(testFile);
  assert.strictEqual(thirdSync, true, 'Sync after modification must update index');

  const hash2 = getContentHash('test-hash-entry');
  assert.notStrictEqual(hash1, hash2, 'Hash must change when content changes');

  const updatedEntry = getEntryById('test-hash-entry');
  assert.ok(updatedEntry?.content.includes('follow redirects'));

  // 4. Remove file and ensure deletion from index
  removeKnowledgeFile(testFile);
  const deletedEntry = getEntryById('test-hash-entry');
  assert.strictEqual(deletedEntry, null, 'Entry must be removed from index upon deletion');

  // Clean up
  if (fs.existsSync(testFile)) fs.unlinkSync(testFile);
  if (fs.existsSync(tempDir)) fs.rmdirSync(tempDir);
});

