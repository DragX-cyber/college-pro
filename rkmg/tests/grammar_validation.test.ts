import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateRedLineAction } from '../src/inference/schema.js';
import { getRedLineGrammar } from '../src/inference/backend.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

test('Grammar Validity: RedLine action protocol conformance', () => {
  // 1. Verify GBNF grammar file exists and loads
  const grammar = getRedLineGrammar();
  assert.ok(grammar.length > 0, 'GBNF grammar must load');
  assert.ok(grammar.includes('root ::='), 'Grammar must define root rule');
  assert.ok(grammar.includes('shell-action'), 'Grammar must define shell-action');

  // 2. Validate valid RedLine JSON actions
  const validShell = {
    thought: 'Sweep the target network using masscan for high speed',
    action: {
      tool: 'shell',
      command: 'masscan -p1-1000 192.168.1.100 --rate=1000',
      reason: 'initial fast discovery',
      timeoutMs: 60000
    }
  };
  assert.strictEqual(validateRedLineAction(validShell).valid, true);

  const validBatch = {
    thought: 'Run initial reconnaissance probes in parallel',
    action: {
      tool: 'shell_batch',
      commands: [
        'dig +short target.local',
        'whois target.local',
        'whatweb http://target.local'
      ],
      reason: 'parallel recon'
    }
  };
  assert.strictEqual(validateRedLineAction(validBatch).valid, true);

  const validRunCheck = {
    thought: 'Check if host responds to ping',
    action: {
      tool: 'run_check',
      check: 'ping',
      target: '192.168.1.1'
    }
  };
  assert.strictEqual(validateRedLineAction(validRunCheck).valid, true);

  const validStrategy = {
    thought: 'Consult strategy board for credential brute forcing options',
    action: {
      tool: 'get_tool_strategy',
      task: 'cred_brute',
      priority: 'stealth'
    }
  };
  assert.strictEqual(validateRedLineAction(validStrategy).valid, true);

  const validKnowledge = {
    thought: 'Look up common mistakes with masscan',
    action: {
      tool: 'get_knowledge',
      query: 'masscan DNS failure'
    }
  };
  assert.strictEqual(validateRedLineAction(validKnowledge).valid, true);

  const validPayload = {
    thought: 'Generate a reverse shell payload',
    action: {
      tool: 'generate_payload',
      kind: 'revshell_python',
      lhost: '10.0.0.5',
      lport: 4444
    }
  };
  assert.strictEqual(validateRedLineAction(validPayload).valid, true);

  const validHoneypot = {
    thought: 'Host opened all ports immediately with identical banners',
    action: {
      tool: 'flag_honeypot',
      target: '192.168.1.99',
      score: 85,
      signals: ['all 65535 ports open', 'instant fake banners'],
      strategy: 'deprioritize target'
    }
  };
  assert.strictEqual(validateRedLineAction(validHoneypot).valid, true);

  const validFinding = {
    thought: 'Identified exposed internal administration panel',
    action: {
      tool: 'note_finding',
      kind: 'exposed_admin',
      title: 'Tomcat Web Application Manager without auth',
      detail: 'HTTP 200 on /manager/html with default admin credentials',
      severity: 'high'
    }
  };
  assert.strictEqual(validateRedLineAction(validFinding).valid, true);

  const validFinal = {
    thought: 'Reconnaissance completed, providing final report to operator',
    action: {
      tool: 'final',
      text: 'Scan complete. Discovered 3 open ports (22, 80, 443). Found 1 high-severity finding.'
    }
  };
  assert.strictEqual(validateRedLineAction(validFinal).valid, true);

  // 3. Reject invalid actions (malformed syntax or unknown tools)
  assert.strictEqual(validateRedLineAction({}).valid, false, 'Empty object must fail');
  assert.strictEqual(
    validateRedLineAction({ thought: 'only thought' }).valid,
    false,
    'Missing action must fail'
  );
  assert.strictEqual(
    validateRedLineAction({ thought: 'test', action: { tool: 'invalid_tool' } }).valid,
    false,
    'Unknown tool must fail'
  );
  assert.strictEqual(
    validateRedLineAction({ thought: 'test', action: { tool: 'shell' } }).valid,
    false,
    'Shell without command must fail'
  );
  assert.strictEqual(
    validateRedLineAction({ thought: 'test', action: { tool: 'final' } }).valid,
    false,
    'Final without text must fail'
  );
});
