# RedLine Auto-Red-Team — Agent Smartness Remediation Plan

_Diagnosis and fix plan for: "the local model is dumb — it does generic recon (crawl web,
find host) regardless of the objective and trusts whatever it finds, even with RAG + system
prompts."_

---

## 1. One-line diagnosis

**The system's intelligence is wired into the wrong places.** The well-designed kill-chain
methodology is locked inside operator-gated *engagements* and never reaches the normal chat
agent; the *strong* model is routed to do the easy work (final write-up) while the *weak* model
makes every tactical decision; the RAG you added barely reaches the model (≤2 entries, 400
chars, planning-only); and grammar-constrained decoding plus "one short line" thoughts actively
suppress the reasoning a small model needs. Fixing "smartness" here is **mostly re-wiring what
already exists**, not buying a bigger model.

---

## 2. Root causes (each tied to code)

### RC-1 — The planning brain is the *weak* model (routing is backwards) ★ biggest
`rkmg/config/models.yaml` + `rkmg/src/routing/router.ts`:
- `fast` tier (9B) is routed `shell`, `shell_batch`, `run_check`, `get_knowledge` — i.e. **every
  action-selection decision**.
- `strong` tier (30B) only gets `get_tool_strategy`, `flag_honeypot`, `note_finding`, `final` —
  mostly bookkeeping + the closing report.
- Routing is **reactive**: `routeRequest()` picks `strong` only when the *previous* assistant
  message already emitted a planning tool, or when a keyword appears in the prompt. The step that
  decides "given this host, what is the smart next move?" is made by the 9B almost every time.
- **The smart model summarizes; the dumb model decides.** That is the "it's dumb" complaint.
- Two more wiring bugs make it worse:
  - In the checked-in config **both tiers point at `http://127.0.0.1:8080`** — the tier split is a
    no-op; everything hits one server.
  - RedLine's `src/core/agent/llm.ts` **never sends `x-redline-action` / `x-redline-tier`
    headers**, so the gateway's only *reliable* routing signal is unused and it falls back to
    guessing from history.

### RC-2 — The chat agent has no plan; it free-forms the methodology
The excellent methodology — `src/core/redteam/killchain.ts` (`TASK_TEMPLATES`, phases, domain
coverage, exploit ladder) and `planner.ts` (`planEngagement`) — is used **only** by the
operator-gated engagement runner (`engines.ts`). The everyday chat path (`orchestrator.ts
runTurn`) gives the model *no structured plan*. A weak model with no plan falls back to a rote,
generic playbook ("crawl the web, find the host") instead of reasoning from the specific
objective. That is the "does normal/generic exploits regardless of objective" complaint.

### RC-3 — RAG barely reaches the model, and teaches the wrong thing
`src/core/knowledge.ts → getKnowledgeContext()` injects **only `planning`-kind entries, max 2,
capped at 400 chars**. Everything else (tool usage, syntax, mistakes) is pulled *on demand* via
the `get_knowledge` action — which a dumb model rarely calls. So at turn start the model is
nearly blind. Worse, the seed pack (`rkmg/knowledge/seed/*.md`) is **tool cheat-sheets** (how to
run nmap/curl), not **tactical decision rules** (what to do when, what a finding means, when to
distrust output). RAG that teaches syntax cannot fix judgment.

### RC-4 — No verification / self-critique gate ("whatever it found is correct")
The loop records findings but never forces the model to **confirm** a result, cross-check, or
distrust surface output before concluding. The only skepticism in the system is the honeypot
heuristic (`honeypot.ts`) — there is no general "is this a false positive? corroborate before you
believe it" step. The prompt even pushes early stopping ("execute only the required check and
call `final` immediately"), which is right for "ping X" but wrong for an assessment. Net effect:
the model accepts the first tool output as truth and stops.

### RC-5 — Decoding settings suppress reasoning on small models
- `rkmg/src/inference/backend.ts` sends `response_format: {type:'json_object', schema:...}`, so
  the model must emit valid action-JSON from the very first token — it **cannot write a free-text
  reasoning preamble**. All "thinking" is squeezed into one `thought` string.
- `rkmg/src/inference/schema.ts` describes `thought` as *"One short line of reasoning"* and
  `prompts.ts`'s LOW thinking level collapses it to <20 words. The scaffold tells the model **not
  to think**.
- Temperature is pinned (0.2 in `llm.ts` and both tiers) with no per-phase tuning.
- Grammar-constrained decoding itself measurably lowers reasoning quality on small models; here
  it's applied to the reasoning step, not just the final emission.

### RC-6 — Honest fundamentals
A 9B model doing autonomous pentest planning will be weak no matter how good the scaffold is. The
MoE `qwen3-30b-a3b` (≈3B active params) is nearly as cheap to run and much stronger for
multi-step reasoning. Model choice for the *decision* step matters.

---

## 3. The plan (prioritized P0 → P3)

> Guiding principle: **put the strong model (and a real plan) on the thinking; keep the weak model
> for mechanical work; force the agent to follow a plan and verify before it concludes.**

### P0 — Quick wins (hours, highest impact)

1. **Flip the routing: strong model decides, weak model executes.** (RC-1) — ✅ **IMPLEMENTED 2026-11-15**
   - Done: `models.yaml` `default_tier: strong`; honest single-model config (both tiers →
     the local 9B @ :8080, non-breaking) with a documented upgrade path to a bigger local
     model or a remote strong API; per-tier `api_key` / `api_key_env` support in
     `rkmg/src/inference/backend.ts` (sends `Authorization: Bearer` for a remote tier, and
     uses standard JSON mode instead of the llama-server schema for remote tiers); RedLine
     now sends `X-RedLine-Tier: strong` on every ReAct reasoning turn
     (`llm.ts` + `orchestrator.ts`) so the gateway routes deterministically instead of
     guessing from history. RKMG typecheck + 5/5 tests green.
   - ⚠️ **Caveat for the current setup:** you run only **one local model (qwen3.5-9b)**, so
     routing to the "strong" tier lands on the same 9B — this is now correct *plumbing*, but
     it does not itself make the agent smarter until `strong` points at a genuinely stronger
     brain. For a lone 9B, the real wins are P0.2 (let it reason), P0.3 (RAG), and P1.
   - Original design notes below.
   - In `models.yaml`, move the *decision* actions (`shell`, `shell_batch`, `run_check`) to the
     `strong` tier, or simplest: set `default_tier: strong` so the reasoning step always uses the
     strong model, and only route confirmed-trivial mechanical sub-calls to `fast`.
   - Point the two tiers at **distinct endpoints** (`:8081` fast, `:8082` strong) as the README
     already describes, so the split is real.
   - Make RedLine send the routing signal: in `llm.ts`, add an `x-redline-tier` (or
     `x-redline-action`) header from the orchestrator so routing is deterministic instead of
     guessed. Pass the intended tier down from `runTurn`.
   - If you only have VRAM for one model: **run the whole agentic loop on the 30B-a3b** and drop
     the 9B to embeddings/mechanical only. One good brain beats two mismatched ones.

2. **Let the model think before it acts.** (RC-5) — ✅ **IMPLEMENTED 2026-11-15**
   - Done: rewrote the LOW/MEDIUM/HIGH thought protocols in `prompts.ts` into real
     objective→evidence→options→decision deliberation (with built-in skepticism and
     anti-generic-recon framing); added a top-level **REASONING DISCIPLINE** section that
     directly targets the two reported failures ("tie every step to the objective, no rote
     playbook" and "distrust single/too-clean results, corroborate before believing");
     defaulted `thinkingLevel` to `high` (`settings.ts`).
   - Structural freedom: added a per-tier `structured_output` mode to the gateway
     (`schema` | `json` | `off`) so the decision tier isn't forced to fight the 9-branch
     grammar while reasoning — it uses `json` (valid JSON, free-form `thought`). `off` is
     available if a model is still too rote (RedLine's tolerant parser handles shape).
   - Per-tier temperature is now authoritative in the gateway (strong = 0.3 for planning,
     fast = 0.2 for command emission); updated the RKMG `thought` schema description.
   - RKMG typecheck + 5/5 tests green.

2b. **DeepSeek as the strong/decision tier (the hybrid that makes P0.1 pay off).** — ✅ **IMPLEMENTED 2026-11-15**
   - `models.yaml` strong tier → `deepseek-chat` @ `https://api.deepseek.com`, key from
     `DEEPSEEK_API_KEY`; fast tier stays the local 9B for execution. Decisions now run on a
     genuinely strong brain; tool execution stays local.
   - Gateway: per-tier `api_key` / `api_key_env` + `Authorization: Bearer` (remote tiers use
     standard JSON mode, not the llama-server schema); dependency-free `.env` loader +
     `.env.example` + a startup warning when a tier's key env var is missing.
   - **Safe default / auto-fallback:** if `DEEPSEEK_API_KEY` is unset, the router transparently
     falls back to the local tier for every request (the logical tier choice is preserved for
     headers), so the gateway runs out of the box with no key and switches to DeepSeek the
     moment a key is present. Covered by a new regression test in `rkmg/tests/routing.test.ts`.
   - **Activate:** put your key in `rkmg/.env` (`DEEPSEEK_API_KEY=sk-...`), then set RedLine
     provider = `openai-compat`, baseURL `http://localhost:8000/v1`, and start the gateway.
   - Fully-local fallback documented inline in `models.yaml` (point strong back at the 9B,
     or a bigger local model on another port).

3. **Make turn-start RAG actually land.** (RC-3)
   - In `getKnowledgeContext()` raise the budget (e.g. 6–8 entries / ~1.5k chars) and include
     `tool_usage` + `mistake` kinds for the task, not just `planning`.
   - **Pre-flight knowledge**: before running a tool, auto-inject that tool's usage + known
     mistakes into the observation the model sees *next* (today hints fire only *after* a
     failure — `createCommandHint`). Prevent the mistake instead of learning from it.

### P1 — Give the chat agent the methodology (days, high impact)

4. **Reuse the kill-chain as a lightweight plan in `runTurn`.** (RC-2)
   - Add an intent classifier up front (deterministic keywords first, strong model as fallback)
     that splits **narrow question** ("ping X", "is X up") from **assessment** ("pentest X",
     "find vulns on X").
   - For assessments, generate a compact plan from the existing `planEngagement` /
     `TASK_TEMPLATES` scoped to the target+objective, and inject it into the system prompt as a
     **checklist the model must follow and tick off** (phase → next 1–3 concrete steps). This is
     what stops generic rote recon: the sequence is derived from the objective, not the model's
     habit.
   - Keep the narrow path fast: one check → `final`, as today.

5. **Add a verification / reflection gate before `final`.** (RC-4)
   - When the model calls `final` on an assessment, run one **strong-model critique pass**: "Are
     these findings corroborated? Any false positives / honeypot / soft-404 / filtered-vs-open
     confusion? Was the objective actually covered?" If it fails, feed the critique back as an
     observation and continue; only accept `final` once it passes (cap the retries).
   - Add cheap corroboration rules as knowledge + light code: e.g. a masscan "open" port is
     *unconfirmed* until `nmap -sV` agrees; every-path-200 ⇒ wildcard/soft-404, not real content.

### P2 — Make knowledge teach judgment, and measure it (days)

6. **Rewrite the knowledge base from cheat-sheets to decision rules.** (RC-3/RC-4)
   - Add `planning`- and `mistake`-kind entries that encode *tactical judgment* and
     *finding-validation* ("when you see X, do Y / don't trust Z until W"). Tag them so retrieval
     hits them for the right task.
   - Ensure embeddings are actually populated so the hybrid vector+keyword path (coverage ≥ 0.6
     gate in `knowledge.ts` / `rkmg/knowledge`) engages instead of silently degrading to keyword.

7. **Build an eval harness so "smartness" is measurable, not vibes.** (college-project rigor)
   - Extend `rkmg/scripts/benchmark.ts` into a scenario suite: fixed targets with a known-correct
     action sequence / expected findings, scored on objective-alignment, no-generic-recon, and
     false-positive rate. Run it before/after each change. This also makes a strong report/demo.

### P3 — Polish

8. **Structured running state in context.** Keep a compact, always-fresh "objective + findings so
   far + plan checklist" block at the top of context each step (instead of re-deriving from
   compacted history in `orchestrator.ts`), so the model never loses the thread and defaults to
   generic behavior. 
9. **Per-phase sampling + budgets**, honeypot score surfaced into the reflection step, and a
   "distrust single-source findings" severity rule in `note_finding`.

---

## 4. Suggested order of execution

1. P0.1 routing flip + real endpoints + header  → immediate jump in decision quality.
2. P0.2 let it think (relax grammar on reasoning, longer thought).
3. P0.3 fatter, pre-flight RAG.
4. P1.4 plan-injection for assessments.
5. P1.5 verification gate.
6. P2.6/P2.7 judgment-knowledge + eval harness.
7. P3 polish.

Each of P0.1–P0.3 is independently shippable and independently testable — do them first and
re-measure before investing in P1/P2.

---

## 5. Realistic expectations

- Autonomous pentest reasoning is genuinely hard for <30B local models; the goal is a reliable
  *scaffolded* operator, not a genius. The scaffold (plan + verify + judgment-RAG) is what makes a
  modest model behave competently.
- Grammar constraints guarantee valid output but cost reasoning — apply them to the *action*, not
  the *thinking*.
- Measure with the eval harness; "feels smarter" is not a result you can defend in a viva.
