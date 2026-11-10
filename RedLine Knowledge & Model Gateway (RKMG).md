# RedLine Knowledge & Model Gateway (RKMG)

### Product Requirements Document

**Project:** RedLine (Auto Red Team Platform) **Component:** External LLM + Knowledge Gateway **Author:** Dheeraj Kumar B K **Status:** Draft v1

---

## 1. Problem Statement

RedLine currently embeds LLM provider logic and knowledge retrieval directly inside the orchestrator. This creates two coupled problems:

1. **Model intelligence ceiling** — Qwen3.5-9B struggles with multi-step planning and reliably emitting protocol-compliant JSON, causing parse failures that the orchestrator has to patch around (`salvageAction()`, deadlock breaker, parse-failure logging).
2. **Performance degradation with knowledge on** — per-turn knowledge retrieval injects variable text into the prompt, invalidating llama-server's `cache_prompt` KV-cache prefix match. This forces full context reprocessing on every turn instead of incremental decoding, causing severe slowdowns as context grows.

Both problems stem from mixing *inference*, *retrieval*, and *orchestration* concerns in one process. This PRD defines a standalone service — the **RedLine Knowledge & Model Gateway (RKMG)** — that isolates model serving and knowledge retrieval behind a single OpenAI-compatible endpoint, so RedLine's orchestrator only ever talks to one stable API and never touches retrieval, embeddings, or model routing directly.

---

## 2. Goals

- RedLine connects to intelligence via **one endpoint only** (`openai-compat` provider, already supported in `llm.ts`) — zero orchestrator changes required beyond a base URL.
- Eliminate KV-cache invalidation caused by per-turn knowledge injection.
- Support editable, version-controllable knowledge as plain text files, with a vector index that auto-syncs from them — never hand-edited directly.
- Support model routing (cheap model for routine steps, stronger model for planning) transparently, invisible to RedLine.
- Keep the entire system local — no external network dependency for inference or embedding.
- Preserve RedLine's existing JSON action protocol (`{"thought":..., "action":{"tool":...}}`) without requiring orchestrator-side changes.

## 3. Non-Goals

- RKMG does not implement red-team logic, guard chains, or charter scoping — that stays entirely in RedLine.
- RKMG does not replace RedLine's `campaign.ts` session state — it only reads session/engagement identifiers RedLine already sends.
- Not building a multi-tenant or cloud-hosted service — single-operator, single-machine (or LAN) scope for v1.
- Not supporting non-local/remote model backends in v1 (API routing to Anthropic/OpenAI is a stretch goal, see §9).

---

## 4. System Architecture

```
RedLine (orchestrator, llm.ts)
   │  POST /v1/chat/completions   (openai-compat, single base URL)
   ▼
┌─────────────────────────────────────────────────────┐
│                 RKMG Gateway Service                 │
│                                                       │
│  ┌───────────────┐   ┌───────────────────────────┐   │
│  │ Session Cache  │──▶│ Knowledge Retrieval Layer │   │
│  │ (per engagement)│  │ (once per session/        │   │
│  └───────────────┘   │  checkpoint, not per-turn) │   │
│                       └─────────────┬──────────────┘   │
│                                     ▼                  │
│                       ┌───────────────────────────┐   │
│                       │  Vector Index (sqlite-vec) │   │
│                       │  auto-synced from /knowledge│  │
│                       └─────────────┬──────────────┘   │
│                                     ▲                  │
│                       ┌─────────────┴──────────────┐   │
│                       │  File Watcher + Hash-Diff   │   │
│                       │  (knowledge/*.md = truth)   │   │
│                       └─────────────────────────────┘   │
│                                                       │
│  ┌───────────────┐   ┌───────────────────────────┐   │
│  │ Routing Layer  │──▶│ Inference Backends         │   │
│  │ (action-type   │   │ (llama.cpp servers,        │   │
│  │  based)        │   │  one per model tier)       │   │
│  └───────────────┘   └───────────────────────────┘   │
└─────────────────────────────────────────────────────┘
```

### 4.1 Components

| Component | Responsibility |
| --- | --- |
| **Gateway API** | Single OpenAI-compatible `/v1/chat/completions` endpoint. Only surface RedLine talks to. |
| **Session Cache** | Maps a RedLine session/engagement id to its stable injected knowledge block and routing state. |
| **Knowledge Retrieval Layer** | Embeds the task/target context once per session or explicit checkpoint; retrieves top-k entries; produces a fixed text block. |
| **File Watcher + Sync** | Watches `knowledge/{seed,operator,autolearn}/*.md`; hash-diffs on change; re-embeds only changed entries; upserts into vector index. |
| **Vector Index** | sqlite-vec (or LanceDB) embedded store. Derived cache only — never edited directly. |
| **Routing Layer** | Inspects incoming request (action type / custom header) and selects which inference backend to call. |
| **Inference Backends** | One or more `llama-server` instances (e.g. a fast small model for routine steps, a larger model for planning), each with grammar-constrained JSON decoding enabled. |

---

## 5. Functional Requirements

### 5.1 Gateway API

- **FR-1**: Expose `POST /v1/chat/completions`, request/response shape fully OpenAI-compatible so RedLine's existing `openai-compat` provider works unmodified.
- **FR-2**: Accept an optional session/engagement identifier (e.g. via a custom header `X-RedLine-Session` or inferred from a stable field in the message history) to key session cache and knowledge injection.
- **FR-3**: Return standard OpenAI-style streaming or non-streaming responses, matching whatever mode `llm.ts` currently expects.

### 5.2 Knowledge Layer

- **FR-4**: Knowledge entries live as Markdown files with YAML frontmatter (`id`, `tool`, `tags`, `kind`, `source`) under `knowledge/seed/`, `knowledge/operator/`, `knowledge/autolearn/` — mirroring RedLine's existing three sources.
- **FR-5**: A file watcher detects create/edit/delete events; on edit, re-embed only if content hash changed from the stored value for that `id`.
- **FR-6**: Vector index stores: `id`, `embedding`, `content_hash`, `source`, `metadata`. Never manually edited — fully derived from the text files.
- **FR-7**: Retrieval happens **once per session** (at engagement start, using charter/target/task context) or at explicit checkpoints RedLine triggers (e.g. new service version discovered) — never on every turn.
- **FR-8**: The retrieved knowledge block, once computed for a session, is injected into the system prompt and does not change for the remainder of that session/checkpoint window, preserving `cache_prompt` prefix stability on the inference backend.
- **FR-9**: Auto-learned mistakes (from RedLine's `absorbFailure()`) are written as new files under `knowledge/autolearn/`, picked up by the same watcher/sync path as any manual edit.

### 5.3 Routing

- **FR-10**: Gateway inspects the action-type signal in the incoming request (RedLine includes it, or routing infers it from the system prompt's current stage) and routes to:
- a fast/light model for `shell`, `run_check`, routine parsing steps
- a stronger model for `get_tool_strategy`, exploitation decisions, `final`
- **FR-11**: Routing is fully transparent — RedLine does not need to know which backend served a given response.

### 5.4 Inference

- **FR-12**: Each inference backend runs via `llama-server` with grammar-constrained decoding (GBNF) enforcing RedLine's JSON action schema, eliminating malformed-JSON parse failures at the source.
- **FR-13**: `cache_prompt: true` enabled on all backends; gateway guarantees prompt-prefix stability within a session as the mechanism that makes this effective (see FR-8).

### 5.5 Knowledge Editing Workflow

- **FR-14**: Editing a `.md` file under `knowledge/` is the only supported edit path. Saving the file triggers hash-diff → re-embed → upsert automatically, with no manual re-index step required.
- **FR-15**: Deleting a `.md` file removes the corresponding vector index entry.

---

## 6. Non-Functional Requirements

- **NFR-1 (Performance)**: No per-turn latency increase from knowledge retrieval after the first turn of a session — retrieval cost is paid once per session/checkpoint, not amortized per call.
- **NFR-2 (Locality)**: No network dependency for inference or embedding in v1; gateway, inference backends, and vector index all run on the same machine or LAN.
- **NFR-3 (Auditability)**: Knowledge files are plain text and git-trackable; changes are diffable and revertible.
- **NFR-4 (Compatibility)**: Zero changes required to RedLine's orchestrator, guard chain, or campaign state beyond pointing `llm.ts`'s `openai-compat` provider at the gateway's base URL.
- **NFR-5 (Resilience)**: If the vector index or file watcher fails, gateway degrades to keyword-only retrieval (matching RedLine's existing fallback behavior) rather than failing the request.

---

## 7. API Contract (RedLine ↔ Gateway)

**Request** (unchanged OpenAI chat format, RedLine already produces this):

```json
POST /v1/chat/completions
Headers: X-RedLine-Session: <engagement_id>
{
  "model": "redline-gateway",
  "messages": [ ...history... ],
  "max_tokens": 768,
  "stream": false
}
```

**Response** (standard OpenAI chat completion shape):

```json
{
  "choices": [{ "message": { "role": "assistant", "content": "{\"thought\":...,\"action\":{...}}" } }]
}
```

RedLine requires no parsing changes — the gateway's job is to make sure `content` is always valid per the grammar constraint.

---

## 8. Milestones

| Phase | Deliverable |
| --- | --- |
| **P1** | Gateway skeleton: OpenAI-compatible endpoint proxying straight to one llama-server instance, no knowledge/routing yet. Validates RedLine connects with zero orchestrator changes. |
| **P2** | Knowledge layer: file structure, watcher, sqlite-vec index, once-per-session retrieval + injection. Validate `cache_prompt` prefix stability via llama-server logs. |
| **P3** | Grammar-constrained decoding (GBNF) for the JSON action schema. Validate parse-failure rate drops to near zero. |
| **P4** | Routing layer across two model tiers. Validate planning-quality improvement on `get_tool_strategy`/`final` steps without slowing routine steps. |
| **P5** | Auto-learned mistake ingestion wired end-to-end from RedLine → `knowledge/autolearn/` → sync → index. |

---

## 9. Risks & Open Questions

- **Session identification**: RedLine's orchestrator must expose a stable session/engagement id the gateway can key on — confirm whether `campaign.ts` already has one or whether this needs a small RedLine-side addition (the only place a RedLine change might be unavoidable).
- **Checkpoint triggering**: who decides a knowledge checkpoint is needed mid-session (new service version discovered, etc.) — RedLine signaling this via a header, or the gateway heuristically detecting it from message content?
- **Multi-backend resource contention**: running two llama-server instances (fast + strong model) simultaneously needs enough VRAM/RAM headroom — confirm hardware budget before P4.
- **Stretch goal**: optional routing to a remote API model (Anthropic/OpenAI) for planning steps only, reusing RedLine's existing `anthropic`/`openai` provider types as a fallback path inside the gateway rather than in RedLine itself.

---

## 10. Success Metrics

- Parse-failure rate (from `.redline/agent-parse-failures.log` equivalent) drops to near-zero post P3.
- Turn-to-turn latency with knowledge enabled matches latency with knowledge disabled, after the first turn of a session.
- Zero RedLine orchestrator code changes required beyond the gateway base URL, through P3.
- Knowledge edits (file save) reflected in retrieval results within the watcher's debounce window, with no manual re-index step ever required.
