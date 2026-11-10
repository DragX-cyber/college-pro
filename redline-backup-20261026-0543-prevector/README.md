# REDLINE — AI Red Team Operations Platform

Autonomous red-team platform with **charter-scoped guards below the AI**, three
operating modes, a capability-aware tool marketplace, honeypot detection and
low-footprint engagements. Works with **local models (Ollama / LM Studio /
llama.cpp / OpenAI-compatible)** and **API keys (OpenAI / Anthropic)** plus the
built-in Z.AI provider. One codebase, **two frontends**: a cyberpunk web console
and a Claude Code-style CLI.

## Setup on your PC

### Prerequisites
- [Bun](https://bun.sh) 1.1+ (runs natively on Windows, macOS and Linux)
  - Windows: `powershell -c "irm bun.sh/install.ps1 | iex"` (or `winget install Oven-sh.Bun`)
  - WSL/Linux/macOS: `curl -fsSL https://bun.sh/install | bash`
- Optional for Linux-side tools: **WSL Kali** (`wsl --install -d kali-linux` on Windows)

### Install & initialize
```bash
cd redline
bun install               # dependencies (uses bun.lock)
cp .env.example .env      # database location
bun run db:push           # create/refresh the SQLite schema (db/custom.db)
bun run smoke             # optional: 38-check core engine self-test
```

> No API key needed to start — configure providers later in **Settings** (web)
> or `/provider` (CLI). Local models work through Ollama / LM Studio /
> llama.cpp (`llama-server`) / any OpenAI-compatible endpoint.

On startup the agent service **auto-detects tools**: it runs `which <bin>` for
every marketplace tool inside the red-team shell (WSL Kali / bash / PowerShell)
and registers what it finds on the agent's tool board — no manual installs
needed. Re-scan anytime: **Market → auto-detect installed**, `/autodetect` in
the CLI, or `POST /api/marketplace/autodetect`.

### Run
```bash
bun run service      # socket.io agent service  → :3003 (must run first)
bun run dev          # web console              → http://localhost:3000
bun run cli          # Claude Code-style TUI    → interactive REPL
```

**Windows one-click:** double-click `start.bat` — it locates bun, installs
dependencies and the DB schema if missing, warns when llama-server is down,
starts both services in their own windows (skipping anything already running)
and opens the browser. `stop.bat` stops both. Nothing to remember.

One-shot CLI (non-interactive):
```bash
bun run cli --cmd "/system"
bun run cli --cmd "/tools"
bun run cli --eval "recon localhost: ping it and curl http://localhost:3000/"
```

### First-run checklist
1. `python3 charter_add.py add <target> --detect` — authorize your first target
   (writes `lab/charter.yaml`; **the AI can never edit the charter**).
2. Open **Settings** in the web console → pick provider (Z.AI / Ollama /
   LM Studio / OpenAI / Anthropic) + model.
3. Chat in the console (or CLI). Default mode is **FREE TERMINAL**.
4. Try the **Market** view — registering a tool teaches the agent its purpose,
   usage, capability scores, pros **and flaws**.

## Windows + WSL Kali

The agent is told the exact environment (`src/core/os.ts`): host OS, WSL
distros (Kali preferred when present), exec kind (`wsl-bash` / `native-bash` /
`powershell`), and a per-session scratch directory. On Windows, Linux tools
run inside `wsl -d <kali> --cd <scratch> -- bash -lc …`; on pure Linux/macOS
they run natively in the scratch dir.

Local LLM endpoints reach the host from WSL via `host.docker.internal` or your
LAN IP (noted in Settings). Install Kali-side tools either through the Market
(it can run the install command in WSL with your approval) or manually with
`sudo apt install nmap masscan …`.

## Architecture

```
src/core/                     ← single source of truth (shared by web + CLI + service)
  charter.ts                  ← two-sided resolveTarget, loaded FRESH every action, AI can never edit
  guardPatterns.ts            ← destructive table (no off switch), read-only classification, hostsIn()
  guards.ts                   ← kill switch, rate limit, no-repeat, egress, approval registry
  wrapper.ts                  ← the FIVE-STEP sequence (scope→rate→policy→execute→capture/audit)
  os.ts                       ← Windows/WSL-Kali detection, exec bridge, per-session scratch
  executor.ts                 ← the ONLY place a command becomes a process (streamed, timeout)
  agent/llm.ts                ← providers: zai, ollama, lmstudio, llamacpp, openai-compat, openai, anthropic
  agent/prompts.ts            ← system prompt: OS + tool board (with flaws!) + mode + charter
  agent/orchestrator.ts       ← ReAct JSON loop, refusals teach, findings/honeypot auto-analysis
  knowledge.ts                ← knowledge RAG: keyword-scored expertise (seed + operator + auto-learned mistakes) injected into prompts
  tools/selector.ts           ← smart selection (masscan for speed, nmap for depth — complement, never discard)
  marketplace/catalog.ts      ← ~30 capability-scored tool manifests
  redteam/                    ← kill chain + domains, planner, honeypot heuristics, footprint, runner
mini-services/agent-service/  ← socket.io :3003 — chat, approvals, mode, kill, market, engagements, audit stream
src/app/                      ← Next.js: page.tsx = single-page shell (only route), 7 views, REST APIs
cli/                          ← REDLINE TUI (banner, boxes, spinner, slash commands, inline approvals)
lab/charter.yaml              ← the written authorization (operator-only)
charter_add.py                ← operator CLI (add/remove/list targets, --detect)
```

## The three modes

| | GUARDED | FREE TERMINAL (default) | UNRESTRICTED |
|---|---|---|---|
| Model writes commands | never — closed set of 4 checks (ping/nslookup/whatweb/curl), fixed argv, no shell | yes — any shell command | yes |
| Charter egress | five-step wrapper scope check | every host in command must resolve into charter | **OFF** (any host) |
| Approval cards | seat ON per closed-set action | non-read-only commands wait | **OFF** (nothing waits) |
| Destructive block | ON | ON | ON — no off switch, protects the operator's machine |
| Rate limits / budgets / kill switch / audit / engagement gate | ON | ON (24 steps, 240s turn, 90s cmd, no-repeat) | ON — all survive |

UNRESTRICTED requires clicking through the red warning dialog, turns the badge
red, runs a banner across every page, broadcasts `[SAFETY]`, and **persists
across restarts** until switched back. Inside UNRESTRICTED, the operator-only
**ENDURANCE** switch (on the mode button · `/endurance` in the CLI) lifts every
time/budget guard: 1000 steps, 24h turns, 1h commands, no per-minute rate cap —
the kill switch, destructive block, no-repeat guard and audits stay on, and
endurance auto-disables when you leave UNRESTRICTED.

## Key behaviors verified end-to-end

- Refusals teach: an invalid tool call returned the fix in-line; the agent
  adapted and completed the task on the next step.
- Charter: unchartered hosts refuse the whole command with the exact
  `charter_add.py` fix; files/binaries (cmd.exe, *.log) are never mistaken for hosts.
- Marketplace: registering a tool broadcasts `tool:registered`; the agent's
  next system prompt includes purpose, usage, capability scores, pros AND flaws.
- Knowledge RAG: a curated seed pack + operator entries + auto-learned
  `mistake` entries (captured when shell commands fail) + online command docs
  (tldr-pages, via **Knowledge → fetch online docs** or `/knowledge docs`) +
  **AI document import** (PDF/DOCX/CSV → entries, **Knowledge → import doc**).
  Retrieval is HYBRID: semantic vectors from a dedicated local embedder
  (`llama-server -m nomic-embed-text-v1.5.Q8_0.gguf --embedding --pooling cls
  -c 8192 --port 8081`, Settings → embedding server) blended with keyword
  scoring — and it silently degrades to keyword-only when the embedder is off.
  The agent pulls knowledge on demand via its `get_knowledge` action. Manage
  in the **Knowledge** view or `/knowledge` in the CLI.
- Engagement: plan (13 tasks, parallel lanes, ladder gates) → heuristic or agent
  run → findings + honeypot heuristics → markdown report with footprint accounting.
- Smart selection: `port_scan + speed → masscan`, complement suggestion `nmap -sV`;
  `service_enum + reliability → nmap`. Scores in `marketplace/catalog.ts`.
- Parallel recon: `shell_batch` fans out independent commands concurrently
  (one step, all outputs together — each command still fully guarded), and the
  heuristic engagement runner executes same-lane recon/enumeration tasks in
  parallel. Concurrency cap = charter `max_concurrent_actions` (Targets page;
  default 1 = sequential).

## Data

Prisma + SQLite (`db/custom.db`): Setting, AuditEvent, ChatSession/Message,
ApprovalRequest, Engagement/Task/Finding, InstalledTool, ToolRun.
Charter is deliberately a FILE (`lab/charter.yaml`) — authorization is data,
not prompts, and it is re-read for every single action.

## Operator tools

```bash
python3 charter_add.py list                 # show authorized targets
python3 charter_add.py add example.com --detect   # authorize + fingerprint
python3 charter_add.py remove example.com   # revoke
```

Use REDLINE **only against systems you are explicitly authorized to test.**
The charter exists so the platform can prove what was and was not in scope.
