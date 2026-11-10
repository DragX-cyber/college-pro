# AGENTS.md — RedLine Knowledge & Model Gateway (RKMG)

This file guides AI coding agents (Claude Code, etc.) working in this repository. It is a **standalone service**, separate from the main RedLine repo. RedLine talks to it over HTTP only — never import RedLine code into this repo, and never import this repo's code into RedLine.

## Project Purpose

RKMG is an OpenAI-compatible gateway that sits between RedLine's orchestrator and one or more local llama.cpp model servers. It owns three things RedLine should never see directly:

1. **Model routing** — picking which local model serves a given request.
2. **Knowledge retrieval** — vector search over a local knowledge base, injected into prompts once per session (not per turn).
3. **Grammar-constrained decoding** — guaranteeing RedLine's JSON action protocol is always valid output.

RedLine's only integration point is `POST /v1/chat/completions`. If a change requires RedLine's orchestrator (`src/core/agent/*`) to be modified, stop and flag it — that almost always means the abstraction leaked and the fix belongs in this repo instead.

## Non-Negotiable Invariants

These exist because of real production bugs. Do not refactor around them without re-reading the PRD section they correspond to.

- **Prompt prefix stability within a session.** Once a knowledge block is injected into a session's system prompt, it must not change for the rest of that session/checkpoint. Changing it breaks `cache_prompt` on llama-server and causes full-context reprocessing. Any code that re-runs retrieval mid-session must go through an explicit "checkpoint" path, never a per-turn path.
- **Vector index is a derived cache, never a primary store.** The only writable source of knowledge is the `knowledge/**/*.md` files. Nothing should ever write directly into the vector DB except the sync pipeline reacting to a file change. If you find yourself writing a vector DB row from anywhere else, that's a bug.
- **API responses are strictly OpenAI-compatible.** RedLine's `openai-compat` provider expects a specific response shape. Do not add custom fields to the top-level response that could break parsing — put gateway-internal metadata in response headers instead, or in the `content` payload if RedLine's parser already tolerates extra JSON fields (verify in the RedLine repo's `llm.ts` before assuming).
- **Grammar constraints enforce RedLine's action schema exactly.** The GBNF grammar (or structured-output schema) must match RedLine's `{"thought": ..., "action": {"tool": ..., ...}}` protocol byte-for-byte in field names. If RedLine's protocol changes, the grammar must change in the same PR — these two repos drift silently otherwise.

## Repository Layout

```
rkmg/
  src/
    gateway/           # HTTP server, /v1/chat/completions handler
    knowledge/
      watcher.ts        # file watcher + hash-diff sync
      embed.ts           # embedding calls to llama-server --embedding
      index.ts            # sqlite-vec read/write wrapper
      retrieve.ts           # once-per-session retrieval logic
    routing/
      router.ts          # action-type → backend selection
    inference/
      backend.ts          # llama-server client, one instance per model tier
      grammar.gbnf          # JSON schema grammar for RedLine's action protocol
    session/
      cache.ts            # session id → injected knowledge block, routing state
  knowledge/
    seed/*.md             # curated entries — hand-edited
    operator/*.md          # operator entries — hand-edited
    autolearn/*.md           # written by RedLine via gateway ingestion endpoint
  config/
    models.yaml             # model tier definitions, endpoints, GPU/VRAM budget
  tests/
  AGENTS.md
  README.md
```

## Setup Commands

```bash
npm install
# Start local inference backends (adjust paths/ports per config/models.yaml)
llama-server -m models/qwen3.5-9b.gguf --port 8081 --cache-prompt
llama-server -m models/qwen3-30b-a3b.gguf --port 8082 --cache-prompt
llama-server -m models/nomic-embed-text.gguf --port 8083 --embedding
# Start the gateway
npm run dev
```

## Development Conventions

- **Language/stack**: TypeScript, Node.js — match RedLine's stack so code patterns stay familiar if logic ever needs to move between repos.
- **No synchronous retrieval in the hot path of turn 2+.** Session cache lookup must be O(1) and not trigger a new embedding call unless a checkpoint was explicitly requested.
- **All inference backend calls go through `inference/backend.ts`.** Never call a llama-server HTTP endpoint directly from gateway or routing code — this keeps backend swapping (e.g. adding a remote API fallback) a one-file change.
- **Every knowledge file write must be idempotent.** Re-syncing the same unchanged file must not re-embed (check content hash first) and must not produce duplicate vector index rows (upsert by `id`, not insert).
- **Config over code for model tiers.** New model tiers (fast/strong/etc.) are added in `config/models.yaml`, not hardcoded in `routing/router.ts`.

## Testing Expectations

- Unit tests for: hash-diff sync logic (file changed vs. unchanged), routing decisions (given action type → expected backend), grammar validity (sample outputs against the GBNF grammar).
- Integration test: simulate a multi-turn session and assert the injected knowledge block byte-for-byte matches across turns 2–N (this is the regression test for the core bug this project exists to fix).
- Before merging any change to `inference/grammar.gbnf`, run it against a batch of recorded RedLine action examples (if available) to confirm no valid action is rejected.

## What NOT To Do

- Don't add per-turn retrieval "for freshness" — this was the original bug. If fresher knowledge is genuinely needed mid-session, it must be an explicit checkpoint, logged as such.
- Don't let the vector index become editable outside the sync pipeline — resist adding an admin UI or API that writes directly to it.
- Don't couple this repo's build/deploy to RedLine's — they must be independently deployable and independently testable.
- Don't hardcode model file paths — use `config/models.yaml` so swapping a model doesn't require a code change.

## Reference

Full requirements, architecture rationale, and milestone breakdown: see the project PRD ("RedLine Knowledge & Model Gateway (RKMG)").
