# RedLine + RKMG

RedLine is an AI red-team operations platform with a web console and CLI.
The standalone RedLine Knowledge & Model Gateway (RKMG) provides an
OpenAI-compatible API for local model routing, knowledge retrieval, and
structured action output. The applications communicate over HTTP and can
run independently.

## Repository layout

- `rkmg/`: TypeScript/Express gateway, tests, model configuration, and Markdown knowledge.
- `redline-backup-20261026-0543-prevector/`: RedLine application source, including its Next.js console, Bun CLI, and Socket.IO service. The folder name is retained because the launch scripts reference it.
- `start-gateway.bat`: launches RKMG on Windows.
- `start-redline.bat` / `stop-redline.bat`: start and stop RedLine on Windows.
- `RedLine Knowledge & Model Gateway (RKMG).md`: gateway requirements and architecture.

## Requirements

- Node.js 22.13+ and npm for RKMG (`node:sqlite` is required).
- Bun for RedLine.
- Local `llama-server` instances and model weights for inference and optional embeddings.

## Run RKMG

From the repository root:

```sh
npm --prefix rkmg ci
npm run dev
```

Review `rkmg/config/models.yaml` before starting model servers. The checked-in
configuration listens on `127.0.0.1:8000`, points both inference tiers at
`127.0.0.1:8080`, and uses `127.0.0.1:8083` for embeddings. Configure distinct
inference endpoints if you serve the tiers separately. Model weights are not
included in this repository.

The gateway serves a test interface at `http://127.0.0.1:8000/`, a health
endpoint at `/health`, and chat completions at `/v1/chat/completions`.
Knowledge retrieval falls back to keyword search when embeddings are unavailable.

```sh
npm test
npm run build
npm start
```

## Run RedLine

```sh
cd redline-backup-20261026-0543-prevector
bun install --frozen-lockfile
```

On Windows PowerShell, create local configuration:

```powershell
Copy-Item .env.example .env
Copy-Item lab/charter.example.yaml lab/charter.yaml
```

On Linux/macOS, use `cp` for those two copies. On a fresh checkout, run:

```sh
bun run db:generate
bun run db:push
```

Start each service in its own terminal from the RedLine directory:

```sh
bun run service
bun run dev
```

Open `http://localhost:3000`. For the CLI, run `bun run cli`.
To connect through RKMG, choose the OpenAI-compatible provider in Settings,
set the base URL to `http://127.0.0.1:8000/v1`, and set the model to
`redline-gateway`.

The example charter contains localhost only. Configure your own authorized
targets through RedLine's operator controls. Databases, settings, and sessions
are created locally; existing operator state is not distributed with the source.

## Knowledge and local files

RKMG's curated knowledge is stored in `rkmg/knowledge/seed/` and
`rkmg/knowledge/operator/`. The SQLite index is a derived cache rebuilt from
Markdown. Local autolearn entries, model weights, environment files, database
files, operator charters, logs, dependency folders, build output, and backup
archives are excluded by `.gitignore`. Dependency lockfiles and configuration
examples are included.

## Upload to GitHub

Create an empty GitHub repository, then run these commands from this directory
(replace `YOUR_USER/YOUR_REPO` with your repository):

```sh
git status --short
git add .
git diff --cached --stat
git commit -m "Initial import of RedLine and RKMG"
git branch -M main
git remote add origin https://github.com/YOUR_USER/YOUR_REPO.git
git push -u origin main
```

Review the staged files before committing. GitHub receives committed files
through `git push`; keep local runtime files on your machine.

For component details, see [RKMG documentation](rkmg/README.md) and
[RedLine documentation](redline-backup-20261026-0543-prevector/README.md).
