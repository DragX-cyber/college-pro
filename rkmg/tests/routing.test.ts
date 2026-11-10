import test from 'node:test';
import assert from 'node:assert';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig, routeRequest } from '../src/routing/router.js';
import { ChatMessage } from '../src/inference/backend.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

test('Routing Decisions: action type and headers -> expected backend', () => {
  const configPath = path.resolve(__dirname, '../config/models.yaml');
  loadConfig(configPath);

  // 1. Routine shell action -> fast tier
  const shellMessages: ChatMessage[] = [
    { role: 'system', content: 'You are REDLINE red team assistant.' },
    { role: 'user', content: 'Scan ports on 192.168.1.10' },
    { role: 'assistant', content: '{"thought":"Run nmap scan","action":{"tool":"shell","command":"nmap -sV -Pn 192.168.1.10","reason":"version scan"}}' },
    { role: 'user', content: 'OBSERVATION: Port 80/tcp open http' }
  ];

  const shellRoute = routeRequest(shellMessages, { 'x-redline-action': 'shell' });
  assert.strictEqual(shellRoute.selectedTier, 'fast', 'shell action should route to fast tier');

  // 2. Routine run_check action -> fast tier
  const runCheckRoute = routeRequest([], { 'x-redline-action': 'run_check' });
  assert.strictEqual(runCheckRoute.selectedTier, 'fast', 'run_check should route to fast tier');

  // 3. Complex tool strategy action -> strong tier
  const strategyRoute = routeRequest([], { 'x-redline-action': 'get_tool_strategy' });
  assert.strictEqual(strategyRoute.selectedTier, 'strong', 'get_tool_strategy should route to strong tier');

  // 4. Final summary synthesis -> strong tier
  const finalRoute = routeRequest([], { 'x-redline-action': 'final' });
  assert.strictEqual(finalRoute.selectedTier, 'strong', 'final action should route to strong tier');

  // 5. Header override takes priority
  const overrideRoute = routeRequest(shellMessages, { 'x-redline-tier': 'strong' });
  assert.strictEqual(overrideRoute.selectedTier, 'strong', 'Header X-RedLine-Tier must override routine routing');

  // 6. Inferred from strategic assistant tool call in message history
  const historyStrategy: ChatMessage[] = [
    { role: 'system', content: 'You are REDLINE red team assistant.' },
    { role: 'user', content: 'Decide attack vector' },
    { role: 'assistant', content: '{"thought":"Checking strategy","action":{"tool":"get_tool_strategy","task":"port_scan"}}' },
    { role: 'user', content: 'OBSERVATION: masscan is recommended for speed' }
  ];
  const historyRoute = routeRequest(historyStrategy);
  assert.strictEqual(historyRoute.selectedTier, 'strong', 'Recent strategy tool call should trigger strong tier');
});

