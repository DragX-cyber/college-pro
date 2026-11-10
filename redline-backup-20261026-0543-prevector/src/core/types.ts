// ─────────────────────────────────────────────────────────────────────────────
// REDLINE core — shared types
// The charter is the platform's single source of authorization. Nothing
// outside it is ever scanned, probed, or exploited.
// ─────────────────────────────────────────────────────────────────────────────

export type Mode = 'guarded' | 'free' | 'unrestricted'
export type ThinkingLevel = 'low' | 'medium' | 'high'

export const MODE_LABEL: Record<Mode, string> = {
  guarded: 'GUARDED',
  free: 'FREE TERMINAL',
  unrestricted: 'UNRESTRICTED',
}

// ─── Charter (lab/charter.yaml — operator's written authorization) ──────────

export interface CharterRules {
  max_concurrent_actions: number
  rate_limit_per_minute: number
  destructive_actions: string // "forbidden" — immutable
  exploit_demo: string | null
  time_budget_minutes: number
}

export interface CharterExploitation {
  ladder_enabled: boolean
  max_rung: number
  replica_host: string | null
  chain_budget: { max_depth: number; max_minutes: number; max_attempts_per_step: number }
}

export interface CharterDeception {
  enabled: boolean
  honeypot_threshold: number
}

export interface CharterScope {
  hosts: string[]
  networks: string[]
  hosts_map: Record<string, string[]>
  base_urls: Record<string, string>
}

export interface Charter {
  engagement_id: string | null
  scope: CharterScope
  rules_of_engagement: CharterRules
  exploitation: CharterExploitation
  deception: CharterDeception
  autonomy: { mode: string }
}

export interface ResolveResult {
  ok: boolean
  reason?: string
  ip?: string
  name?: string
  fix?: string
}

// ─── OS / execution environment ──────────────────────────────────────────────

export interface OSInfo {
  platform: string
  isWindows: boolean
  isLinux: boolean
  release: string
  arch: string
  hostname: string
  user: string
  wsl: {
    available: boolean
    distros: string[]
    preferred: string | null
    kaliPresent: boolean
  }
  exec: {
    kind: 'wsl-bash' | 'native-bash' | 'powershell'
    /** argv prefix that runs one command line inside the red-team shell */
    shellPrefix: string[]
    /** POSIX scratch root visible from inside the red-team shell */
    scratchRoot: string
    note: string
  }
}

// ─── Tools & marketplace ─────────────────────────────────────────────────────

export type ToolCategory =
  | 'core' | 'network' | 'web' | 'dns' | 'ssl' | 'smb' | 'ad'
  | 'snmp' | 'exploit' | 'creds' | 'recon'

export interface CapabilityScore {
  speed: number        // 1-10 raw throughput for the task
  efficiency: number   // 1-10 result-quality per unit of time/noise
  coverage: number     // 1-10 breadth of the task it can cover
  reliability: number  // 1-10 how often results are usable
  notes?: string
}

export interface ToolFlaw {
  context: string
  note: string
}

export interface ToolManifest {
  id: string
  name: string
  category: ToolCategory
  tagline: string
  purpose: string
  usage: string[]
  /** task id -> scores, e.g. { port_scan: {...}, service_enum: {...} } */
  capabilities: Record<string, CapabilityScore>
  pros: string[]
  flaws: ToolFlaw[]
  install: { wsl?: string; win?: string }
  detect: { bin: string }
  stealthNotes?: string[]
  builtin?: boolean
  /** resolved at runtime */
  availability?: 'available' | 'missing' | 'unknown'
}

// ─── Smart tool selector ─────────────────────────────────────────────────────

export type Priority = 'speed' | 'coverage' | 'stealth' | 'reliability' | 'balanced'

export interface ToolChoice {
  id: string
  name: string
  score: number
  speed: number
  efficiency: number
  coverage: number
  reliability: number
  rationale: string
  caveat?: string
}

export interface ToolStrategy {
  task: string
  priority: Priority
  primary: ToolChoice | null
  ranked: ToolChoice[]
  complement: { tools: string[]; note: string } | null
  avoidWhen: string[]
  stealthNotes: string[]
  guidance: string
}

// ─── Honeypot detection ──────────────────────────────────────────────────────

export interface HoneypotSignal {
  name: string
  weight: number
  detail: string
}

export interface HoneypotAnalysis {
  target: string
  score: number
  threshold: number
  verdict: 'likely_honeypot' | 'possible' | 'clean'
  signals: HoneypotSignal[]
  strategy: string
}

// ─── Findings ────────────────────────────────────────────────────────────────

export type Severity = 'info' | 'low' | 'medium' | 'high' | 'critical'

export interface FindingInput {
  kind: string
  title: string
  detail: string
  severity?: Severity
  engagementId?: number | null
  sessionId?: string | null
  honeypotScore?: number | null
  evidence?: string | null
}

// ─── Guard pipeline ──────────────────────────────────────────────────────────

export interface GuardRefusal {
  ok: false
  kind:
    | 'kill_switch'
    | 'destructive_block'
    | 'scope_refused'
    | 'off_target_refused'
    | 'free_command_refused'
    | 'rate_limited'
    | 'loop_blocked'
    | 'budget_exhausted'
    | 'engagement_gate'
    | 'mode_violation'
    | 'approval_denied'
    | 'approval_timeout'
    | 'parse_error'
    | 'tool_unavailable'
  reason: string
  fix?: string
  auditKind: string
  verdict: 'refused' | 'blocked'
}

export interface Classification {
  kind: 'readonly' | 'approval' | 'blocked'
  tool?: string
  reason: string
}

export interface ExecResult {
  command: string
  exitCode: number | null
  durationMs: number
  output: string
  timedOut: boolean
}

// ─── Agent events (orchestrator → UI/CLI, live) ─────────────────────────────

export type AgentEvent =
  | { type: 'agent_start'; turnId: string; mode: Mode; maxSteps: number }
  | { type: 'agent_thought'; text: string }
  | { type: 'action'; tool: string; command?: string; check?: string; target?: string; reason?: string }
  | { type: 'guard'; refusal: GuardRefusal }
  | { type: 'approval_required'; approval: { id: string; tool: string; command: string; reason: string; mode: Mode } }
  | { type: 'approval_resolved'; id: string; decision: 'approved' | 'denied' | 'expired' }
  | { type: 'output_start'; runId: number; label: string }
  | { type: 'output'; runId: number; chunk: string }
  | { type: 'output_end'; runId: number; exitCode: number | null; durationMs: number; verdict: string }
  | { type: 'finding'; finding: FindingInput }
  | { type: 'honeypot'; analysis: HoneypotAnalysis }
  | { type: 'tool_strategy'; strategy: ToolStrategy }
  | { type: 'budget'; stepsLeft: number; turnMsLeft: number; promptTokens?: number }
  | { type: 'final'; text: string }
  | { type: 'final_chunk'; chunk: string }
  | { type: 'thought_chunk'; chunk: string }
  | { type: 'error'; message: string; fix?: string }
  | { type: 'stop_requested' }  // operator pressed STOP — loop interruption follows
  | { type: 'agent_end'; turnId: string; steps: number }

export type EmitFn = (event: AgentEvent) => void | Promise<void>

// ─── LLM providers ───────────────────────────────────────────────────────────

export type ProviderId =
  | 'zai' | 'ollama' | 'lmstudio' | 'llamacpp' | 'openai-compat' | 'openai' | 'anthropic' | 'puter' | 'orca'

export interface ProviderInfo {
  id: ProviderId
  label: string
  description: string
  local: boolean
  needsKey: boolean
  defaultBaseUrl: string
  defaultModel: string
}

export interface LLMResult {
  content: string
  provider: ProviderId
  model: string
  error?: string
}

// ─── Engagements / kill chain ────────────────────────────────────────────────

export type Phase =
  | 'recon' | 'enumeration' | 'vuln_analysis' | 'exploitation' | 'post_exploit' | 'reporting'

export interface PlanTask {
  title: string
  phase: Phase
  domain: string
  parallelGroup: number
  toolHint?: string
  stealthNote?: string
}

export interface EngagementPlan {
  target: string
  objective: string
  profile: 'stealth' | 'balanced' | 'fast'
  phases: { phase: Phase; groups: { group: number; tasks: PlanTask[] }[] }[]
  footprintPolicy: string
  notes: string[]
}

export interface RunContext {
  sessionId?: string
  engagementId?: number
  engagementTarget?: string
}
