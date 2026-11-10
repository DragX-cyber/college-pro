import test from 'node:test';
import assert from 'node:assert';
import {
  getOrComputeSessionKnowledge,
  injectKnowledgeIntoMessages,
  resetAllSessions
} from '../src/session/cache.js';
import { syncAllKnowledge } from '../src/knowledge/watcher.js';
import { ChatMessage } from '../src/inference/backend.js';

test('Integration Test: Prompt Prefix Stability Across Multi-Turn Session (turns 2..N)', async () => {
  resetAllSessions();
  await syncAllKnowledge();

  const sessionId = 'engagement-audit-target-2026';
  const initialTask = 'Perform initial reconnaissance and port scan on 192.168.1.50';

  // --- Turn 1 ---
  // On Turn 1, the knowledge retrieval runs and computes the knowledge block
  const turn1Result = await getOrComputeSessionKnowledge(sessionId, initialTask);
  assert.strictEqual(turn1Result.isTurn1, true, 'Turn 1 must compute initial knowledge block');
  const turn1KnowledgeBlock = turn1Result.knowledgeBlock;
  assert.ok(turn1KnowledgeBlock.length > 0, 'Knowledge block should not be empty');

  const baseSystemPrompt = `You are REDLINE red team assistant.
## ACTIVE ENGAGEMENT: ${sessionId}
target: 192.168.1.50
objective: identify exposed services

## YOUR TOOLS
- nmap
- masscan`;

  const messagesTurn1: ChatMessage[] = [
    { role: 'system', content: baseSystemPrompt },
    { role: 'user', content: initialTask }
  ];

  const preparedTurn1 = injectKnowledgeIntoMessages(messagesTurn1, turn1KnowledgeBlock);
  const turn1SystemPrompt = preparedTurn1.find((m) => m.role === 'system')?.content || '';

  assert.ok(
    turn1SystemPrompt.includes('## KNOWLEDGE (RKMG)'),
    'Turn 1 system prompt must contain injected knowledge block'
  );

  // --- Turn 2 ---
  // In turn 2, new user text arrives (e.g. tool output), but retrieval must NOT run again.
  // It must return the exact same knowledge block in O(1).
  const turn2UserObservation = 'OBSERVATION: Port 80/tcp open. Port 443/tcp open.';
  const turn2Result = await getOrComputeSessionKnowledge(sessionId, turn2UserObservation);

  assert.strictEqual(turn2Result.isTurn1, false, 'Turn 2 must be identified as an ongoing session');
  assert.strictEqual(
    turn2Result.knowledgeBlock,
    turn1KnowledgeBlock,
    'Turn 2 knowledge block must match Turn 1 byte-for-byte'
  );

  const messagesTurn2: ChatMessage[] = [
    { role: 'system', content: baseSystemPrompt },
    { role: 'user', content: initialTask },
    {
      role: 'assistant',
      content: '{"thought":"Scan ports","action":{"tool":"shell","command":"nmap -sV -Pn 192.168.1.50"}}'
    },
    { role: 'user', content: turn2UserObservation }
  ];

  const preparedTurn2 = injectKnowledgeIntoMessages(messagesTurn2, turn2Result.knowledgeBlock);
  const turn2SystemPrompt = preparedTurn2.find((m) => m.role === 'system')?.content || '';

  // Core invariant assertion: The system prompt prefix is identical byte-for-byte
  assert.strictEqual(
    turn2SystemPrompt,
    turn1SystemPrompt,
    'System prompt prefix must be 100% byte-for-byte identical between Turn 1 and Turn 2!'
  );

  // --- Turn 3 ---
  const turn3UserObservation = 'OBSERVATION: Apache/2.4.41 running on port 80.';
  const turn3Result = await getOrComputeSessionKnowledge(sessionId, turn3UserObservation);

  assert.strictEqual(turn3Result.isTurn1, false);
  assert.strictEqual(
    turn3Result.knowledgeBlock,
    turn1KnowledgeBlock,
    'Turn 3 knowledge block must match Turn 1 byte-for-byte'
  );

  const messagesTurn3: ChatMessage[] = [
    ...messagesTurn2,
    {
      role: 'assistant',
      content: '{"thought":"Inspect web service","action":{"tool":"shell","command":"curl -I http://192.168.1.50"}}'
    },
    { role: 'user', content: turn3UserObservation }
  ];

  const preparedTurn3 = injectKnowledgeIntoMessages(messagesTurn3, turn3Result.knowledgeBlock);
  const turn3SystemPrompt = preparedTurn3.find((m) => m.role === 'system')?.content || '';

  assert.strictEqual(
    turn3SystemPrompt,
    turn1SystemPrompt,
    'System prompt prefix must be 100% byte-for-byte identical between Turn 1 and Turn 3!'
  );

  // --- Explicit Checkpoint Path ---
  // When an explicit checkpoint is requested (e.g. major scope change), new retrieval is allowed
  const checkpointTask = 'New scope discovered: pivot to internal MySQL database 10.0.0.1';
  const checkpointResult = await getOrComputeSessionKnowledge(sessionId, checkpointTask, true);

  assert.strictEqual(
    checkpointResult.checkpointVersion,
    2,
    'Explicit checkpoint must advance checkpoint version'
  );
});
