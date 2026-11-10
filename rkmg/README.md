# RedLine Knowledge & Model Gateway (RKMG)

RKMG is an OpenAI-compatible gateway that sits between RedLine's orchestrator and one or more local `llama.cpp` model servers (`llama-server`).

It isolates model serving and knowledge retrieval behind a single standard API, resolving:
1. **KV-Cache Invalidation**: Guarantees prompt prefix stability within an engagement session so `llama-server`'s `cache_prompt` KV-cache match is never broken.
2. **Model Routing**: Transparently routes routine steps (`shell`, `run_check`) to a fast light model (e.g., 9B) and complex planning (`get_tool_strategy`, `final`) to a stronger model (e.g., 30B MoE).
3. **Grammar-Constrained Decoding**: Enforces RedLine's `{"thought": ..., "action": {"tool": ...}}` JSON schema byte-for-byte using GBNF grammar constraints, eliminating JSON parse failures.

---

## Architecture

```
RedLine (Orchestrator, llm.ts)
   │  POST /v1/chat/completions (OpenAI-compatible)
   ▼
┌────────────────────────────────────────────────────────┐
│                      RKMG Gateway                      │
│                                                        │
│  ┌──────────────────┐      ┌────────────────────────┐  │
│  │  Session Cache   │─────▶│ Knowledge Retrieval    │  │
│  │  (per session)   │      │ (once-per-session RAG) │  │
│  └──────────────────┘      └───────────┬────────────┘  │
│                                        ▼               │
│                            ┌───────────────────────┐   │
│                            │ SQLite Vector Index   │   │
│                            └───────────▲───────────┘   │
│                                        │ (hash-diff)   │
│                            ┌───────────┴───────────┐   │
│                            │ File Watcher: *.md    │   │
│                            └───────────────────────┘   │
│                                                        │
│  ┌──────────────────┐      ┌────────────────────────┐  │
│  │  Routing Layer   │─────▶│   Inference Backends   │  │
│  │  (action-type)   │      │ (llama-server + GBNF)  │  │
│  └──────────────────┘      └────────────────────────┘  │
└────────────────────────────────────────────────────────┘
```

---

## Directory Structure

```
rkmg/
  src/
    gateway/
      server.ts         # Express server & OpenAI /v1/chat/completions handlers
      index.ts          # Server entrypoint and lifecycle management
    knowledge/
      watcher.ts        # Chokidar file watcher & SHA-256 hash-diff sync
      embed.ts          # Embedding client for llama-server --embedding
      index.ts          # SQLite derived vector and keyword index
      retrieve.ts       # Once-per-session hybrid retrieval logic
    routing/
      router.ts         # Action-type and header-based model tier selection
    inference/
      backend.ts        # llama-server HTTP client with prompt-caching
      schema.ts         # RedLine action JSON protocol definitions & validator
      grammar.gbnf      # GBNF grammar strictly enforcing action protocol
    session/
      cache.ts          # In-memory session cache enforcing prompt prefix stability
  knowledge/
    seed/*.md           # 50+ curated seed entries with YAML frontmatter
    operator/*.md       # Operator-defined guidance files
    autolearn/*.md      # Automatically learned mistakes ingested via API
  config/
    models.yaml         # Server port, embedding config, and model tiers
  tests/
    hash_diff_sync.test.ts            # Unit test for hash-diff sync
    routing.test.ts                   # Unit test for model routing
    grammar_validation.test.ts        # Unit test for GBNF / schema validation
    session_prefix_stability.test.ts  # Integration test for KV-cache prefix stability
    gateway_api.test.ts               # Integration test for HTTP endpoints
  package.json
  tsconfig.json
  AGENTS.md
  README.md
```

---

## Quickstart

### 1. Install Dependencies
```bash
cd rkmg
npm install
```

### 2. Start Inference Backends (llama-server)
Launch your local `llama-server` instances matching `config/models.yaml`:
```bash
# Fast Tier (e.g., Qwen 3.5 9B) on port 8081 with KV-cache prompt caching
llama-server -m models/qwen3.5-9b.gguf --port 8081 --cache-prompt

# Strong Tier (e.g., Qwen 3 30B MoE) on port 8082
llama-server -m models/qwen3-30b-a3b.gguf --port 8082 --cache-prompt

# Local Embedder on port 8083
llama-server -m models/nomic-embed-text.gguf --port 8083 --embedding
```

### 3. Run RKMG
```bash
# Development (with hot-reload)
npm run dev

# Or Production Build & Start
npm run build
npm run start
```

### 4. Run Automated Test Suite
```bash
npm test
```

---

## Connecting RedLine to RKMG

Zero code changes are required in RedLine's orchestrator. In RedLine's web console or CLI:
1. Navigate to **Settings** → **Provider**.
2. Select **OpenAI-compatible**.
3. Set **Base URL** to `http://127.0.0.1:8000/v1` (or your host IP if connecting from WSL).
4. Set **Model** to `redline-gateway`.

### Session Tracking & Checkpoints
- **Session Identification**: RedLine requests pass `X-RedLine-Session: <engagement_id>`, or RKMG automatically detects active engagement IDs from the prompt history.
- **Mid-Session Checkpoints**: If an explicit knowledge refresh is needed (e.g. pivoting to a newly discovered service), include the header `X-RedLine-Checkpoint: true`.
- **Autolearn API**: RedLine's failure learning logs errors directly to `POST http://127.0.0.1:8000/v1/knowledge/autolearn`, immediately indexing the new rule without restarting the gateway.

