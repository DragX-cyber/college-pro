import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';
import { BackendTierConfig, InferenceBackend, ChatMessage } from '../inference/backend.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export interface GatewayConfig {
  server: {
    host: string;
    port: number;
    log_level?: string;
  };
  embedding: {
    endpoint: string;
    model: string;
    dimensions: number;
    batch_size?: number;
    timeout_ms?: number;
  };
  tiers: Record<string, BackendTierConfig>;
  routing: {
    default_tier: string;
    planning_tier: string;
    planning_keywords?: string[];
  };
}

let loadedConfig: GatewayConfig | null = null;
let backendsMap = new Map<string, InferenceBackend>();

/**
 * Loads configuration from config/models.yaml.
 */
export function loadConfig(configPath?: string): GatewayConfig {
  if (loadedConfig && !configPath) return loadedConfig;

  const resolvedPath = configPath || path.resolve(__dirname, '../../config/models.yaml');
  if (!fs.existsSync(resolvedPath)) {
    throw new Error(`Configuration file not found at: ${resolvedPath}`);
  }

  const raw = fs.readFileSync(resolvedPath, 'utf-8');
  const parsed = yaml.load(raw) as GatewayConfig;

  if (!parsed.tiers || Object.keys(parsed.tiers).length === 0) {
    throw new Error('Invalid config: at least one tier must be defined in models.yaml');
  }

  loadedConfig = parsed;
  backendsMap.clear();

  for (const [tierKey, tierConfig] of Object.entries(parsed.tiers)) {
    backendsMap.set(tierKey, new InferenceBackend(tierConfig));
  }

  return loadedConfig;
}

export function getConfig(): GatewayConfig {
  if (!loadedConfig) return loadConfig();
  return loadedConfig;
}

export function getBackendForTier(tierName: string): InferenceBackend {
  const config = getConfig();
  let backend = backendsMap.get(tierName);
  if (!backend) {
    const fallbackTier = config.routing.default_tier;
    backend = backendsMap.get(fallbackTier);
    if (!backend) {
      // Pick first available tier
      const firstTier = Object.keys(config.tiers)[0];
      backend = backendsMap.get(firstTier);
    }
  }
  if (!backend) {
    throw new Error(`No backend configured for tier: ${tierName}`);
  }
  return backend;
}

export interface RouteInspection {
  selectedTier: string;
  reason: string;
  backend: InferenceBackend;
}

/**
 * Resolve the backend that should actually serve `tierName`. If that tier is a
 * remote provider whose API key is not configured, transparently fall back to a
 * usable local tier (prefer "fast") so the gateway stays runnable out of the box
 * — the logical tier choice is preserved for headers/telemetry; only the backend
 * that executes is swapped. Returns a note describing any fallback.
 */
function resolveUsableBackend(tierName: string): { backend: InferenceBackend; note: string } {
  const primary = getBackendForTier(tierName);
  if (!primary.needsKeyButMissing()) return { backend: primary, note: '' };

  const config = getConfig();
  const candidates = ['fast', config.routing.default_tier, ...Object.keys(config.tiers)];
  const seen = new Set<string>();
  for (const t of candidates) {
    if (!t || t === tierName || seen.has(t)) continue;
    seen.add(t);
    const b = backendsMap.get(t);
    if (b && !b.needsKeyButMissing()) {
      return {
        backend: b,
        note: ` (tier "${tierName}" expects ${primary.getConfig().api_key_env} which is unset — falling back to local tier "${t}")`
      };
    }
  }
  // Nothing better available — let the request proceed and fail loudly.
  return { backend: primary, note: '' };
}

/**
 * Inspects incoming request headers, messages, and prompt stage to route to the appropriate model tier.
 */
export function routeRequest(
  messages: ChatMessage[],
  headers: Record<string, string | string[] | undefined> = {}
): RouteInspection {
  const config = getConfig();
  const defaultTier = config.routing.default_tier || 'fast';
  const planningTier = config.routing.planning_tier || 'strong';

  // Preserves the logical tier choice while swapping in a usable backend when a
  // remote tier's key is missing (see resolveUsableBackend).
  const finalize = (tier: string, reason: string): RouteInspection => {
    const { backend, note } = resolveUsableBackend(tier);
    return { selectedTier: tier, reason: reason + note, backend };
  };

  // 1. Explicit header overrides
  const headerAction = (headers['x-redline-action'] as string)?.toLowerCase()?.trim();
  const headerTier = (headers['x-redline-tier'] as string)?.toLowerCase()?.trim();

  if (headerTier && config.tiers[headerTier]) {
    return finalize(headerTier, `Explicit X-RedLine-Tier header: ${headerTier}`);
  }

  if (headerAction) {
    for (const [tierName, tierConf] of Object.entries(config.tiers)) {
      if (tierConf.actions?.includes(headerAction)) {
        return finalize(tierName, `Action header "${headerAction}" matched tier ${tierName}`);
      }
    }
  }

  // 2. Infer action type from message history
  // If the last observation indicates a need for complex tool strategy, planning, or final report
  const lastUserMsg = [...messages].reverse().find((m) => m.role === 'user')?.content || '';
  const lastAssistantMsg = [...messages].reverse().find((m) => m.role === 'assistant')?.content || '';

  // Check if we are at synthesis/final phase or user requested a strategic plan
  const planningKeywords = config.routing.planning_keywords || [
    'strategy',
    'exploit',
    'plan',
    'summary',
    'analyze',
    'finding',
    'honeypot'
  ];

  // Strong tier actions check in recent context
  for (const [tierName, tierConf] of Object.entries(config.tiers)) {
    if (tierConf.actions) {
      for (const action of tierConf.actions) {
        // If last assistant called get_tool_strategy or final, or user prompted for it
        if (lastAssistantMsg.includes(`"tool":"${action}"`) || lastAssistantMsg.includes(`"tool": "${action}"`)) {
          return finalize(tierName, `Recent action "${action}" matched tier ${tierName}`);
        }
      }
    }
  }

  // Keyword heuristic on user query for first turn
  const lowerUser = lastUserMsg.toLowerCase();
  const matchedKeyword = planningKeywords.find((kw) => lowerUser.includes(kw));
  if (matchedKeyword && config.tiers[planningTier]) {
    return finalize(planningTier, `Planning keyword "${matchedKeyword}" matched in prompt`);
  }

  // Default routine tier
  return finalize(defaultTier, `Default routine tier: ${defaultTier}`);
}

