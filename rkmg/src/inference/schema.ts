// RedLine Action Protocol JSON Schema
// Strictly enforces {"thought": "...", "action": {"tool": "...", ...}}

export const REDLINE_ACTION_JSON_SCHEMA = {
  type: 'object',
  required: ['thought', 'action'],
  properties: {
    thought: {
      type: 'string',
      description: 'One short line of reasoning explaining the tactical intent'
    },
    action: {
      type: 'object',
      required: ['tool'],
      properties: {
        tool: {
          type: 'string',
          enum: [
            'shell',
            'shell_batch',
            'run_check',
            'get_tool_strategy',
            'get_knowledge',
            'generate_payload',
            'flag_honeypot',
            'note_finding',
            'final'
          ]
        },
        command: { type: 'string' },
        commands: {
          type: 'array',
          items: { type: 'string' }
        },
        reason: { type: 'string' },
        timeoutMs: { type: 'number' },
        check: {
          type: 'string',
          enum: ['ping', 'nslookup', 'whatweb', 'curl']
        },
        target: { type: 'string' },
        task: { type: 'string' },
        priority: {
          type: 'string',
          enum: ['speed', 'coverage', 'stealth', 'reliability', 'balanced']
        },
        query: { type: 'string' },
        kind: { type: 'string' },
        lhost: { type: 'string' },
        lport: { type: 'number' },
        score: { type: 'number' },
        signals: {
          type: 'array',
          items: { type: 'string' }
        },
        strategy: { type: 'string' },
        title: { type: 'string' },
        detail: { type: 'string' },
        severity: {
          type: 'string',
          enum: ['info', 'low', 'medium', 'high', 'critical']
        },
        text: { type: 'string' }
      }
    }
  }
} as const;

export function validateRedLineAction(payload: unknown): { valid: boolean; error?: string } {
  if (!payload || typeof payload !== 'object') {
    return { valid: false, error: 'Output is not a JSON object' };
  }
  const obj = payload as Record<string, any>;
  if (typeof obj.thought !== 'string' || !obj.thought.trim()) {
    return { valid: false, error: 'Missing or empty "thought" field' };
  }
  if (!obj.action || typeof obj.action !== 'object') {
    return { valid: false, error: 'Missing or invalid "action" field' };
  }
  const action = obj.action;
  if (typeof action.tool !== 'string') {
    return { valid: false, error: 'Action missing "tool" field' };
  }

  const validTools = [
    'shell',
    'shell_batch',
    'run_check',
    'get_tool_strategy',
    'get_knowledge',
    'generate_payload',
    'flag_honeypot',
    'note_finding',
    'final'
  ];

  if (!validTools.includes(action.tool)) {
    return { valid: false, error: `Invalid tool name "${action.tool}"` };
  }

  switch (action.tool) {
    case 'shell':
      if (typeof action.command !== 'string' || !action.command.trim()) {
        return { valid: false, error: 'shell action requires non-empty "command"' };
      }
      break;
    case 'shell_batch':
      if (!Array.isArray(action.commands) || action.commands.length === 0) {
        return { valid: false, error: 'shell_batch action requires non-empty "commands" array' };
      }
      break;
    case 'run_check':
      if (!['ping', 'nslookup', 'whatweb', 'curl'].includes(action.check)) {
        return { valid: false, error: `run_check invalid check type: ${action.check}` };
      }
      if (typeof action.target !== 'string' || !action.target.trim()) {
        return { valid: false, error: 'run_check requires non-empty "target"' };
      }
      break;
    case 'get_tool_strategy':
      if (typeof action.task !== 'string' || !action.task.trim()) {
        return { valid: false, error: 'get_tool_strategy requires non-empty "task"' };
      }
      break;
    case 'get_knowledge':
      if (typeof action.query !== 'string' || !action.query.trim()) {
        return { valid: false, error: 'get_knowledge requires non-empty "query"' };
      }
      break;
    case 'generate_payload':
      if (typeof action.kind !== 'string' || !action.kind.trim()) {
        return { valid: false, error: 'generate_payload requires "kind"' };
      }
      if (typeof action.lhost !== 'string' || !action.lhost.trim()) {
        return { valid: false, error: 'generate_payload requires "lhost"' };
      }
      break;
    case 'flag_honeypot':
      if (typeof action.target !== 'string' || !action.target.trim()) {
        return { valid: false, error: 'flag_honeypot requires "target"' };
      }
      if (typeof action.score !== 'number' || action.score < 0 || action.score > 100) {
        return { valid: false, error: 'flag_honeypot score must be 0-100' };
      }
      break;
    case 'note_finding':
      if (typeof action.title !== 'string' || !action.title.trim()) {
        return { valid: false, error: 'note_finding requires "title"' };
      }
      if (!['info', 'low', 'medium', 'high', 'critical'].includes(action.severity)) {
        return { valid: false, error: 'note_finding requires valid "severity"' };
      }
      break;
    case 'final':
      if (typeof action.text !== 'string' || !action.text.trim()) {
        return { valid: false, error: 'final action requires non-empty "text"' };
      }
      break;
  }

  return { valid: true };
}

