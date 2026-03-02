# OpenIntern

English | [简体中文](./README.zh-CN.md)

A production-grade, multi-tenant AI Agent Runtime. It provides agent execution, event tracing, team orchestration, HITL approvals, and a three-tier memory system backed by PostgreSQL.

## Architecture

```
┌──────────────────────────────────────────────────────────┐
│                    Web UI (React + Vite)                │
│   Playground / Runs / Trace / Inbox / Team / Ingest     │
└───────────────────────┬──────────────────────────────────┘
                        │ REST + SSE
┌───────────────────────┴──────────────────────────────────┐
│                  Backend (Express + TypeScript)          │
│                                                          │
│  Run Queue ─→ Agent Runner (step loop) ─→ Tool Router   │
│       │            │                          │          │
│       │      Checkpoint Service         MCP / Built-in  │
│       │            │                                     │
│  Orchestrator ─→ Swarm Coordinator (group runs)         │
│       │                                                  │
│  Approval Manager (HITL) + Memory Service               │
└───────────────────────┬──────────────────────────────────┘
                        │
┌───────────────────────┴──────────────────────────────────┐
│             PostgreSQL + pgvector + pgcrypto            │
└──────────────────────────────────────────────────────────┘
```

## Features

- **Multi-tenant isolation** scoped by `org_id` / `user_id` / `project_id`
- **Run execution engine** with queueing, checkpoints, suspension, and resume
- **Event sourcing + SSE** for full traceability and real-time streaming
- **Three-tier memory**: Core / Episodic / Archival with vector + FTS retrieval
- **Team orchestration**: roles, groups, blackboard, swarm dependencies
- **HITL approvals** for high-risk tool calls (`waiting` / `suspended` flows)
- **Tool ecosystem**:
  - memory (`memory_search/get/write/list/delete`)
  - file (`read/write/list/glob/grep/delete/move/replace_in_file`)
  - coding (`exec_command`)
  - export / routing / escalation / skill tools
- **Integrations**: Feishu connectors and MinerU batch PDF ingest
- **Multi-LLM support**: OpenAI, Anthropic, Gemini via unified config
- **Three interfaces**: Web UI, CLI, REST API

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Backend | Node.js 20+ / TypeScript / Express |
| Database | PostgreSQL 15+ / pgvector / pgcrypto |
| Frontend | React 18 / TypeScript / Vite |
| MCP Server | Python 3.9+ (stdio protocol) |
| Validation | Zod |
| Testing | Vitest / Playwright / pytest |

## Quick Start

### Prerequisites

- Node.js >= 20, pnpm >= 8
- PostgreSQL >= 15 with `vector` and `pgcrypto` extensions
- Python >= 3.9 (only if using MCP tools)

### Install

```bash
# Backend + CLI
pnpm install

# Frontend
pnpm --dir web install

# Python MCP (optional)
cd python && pip3 install -e . && cd ..
```

### Configure

```bash
# Required: PostgreSQL connection
export DATABASE_URL='postgres://user:pass@127.0.0.1:5432/openintern'

# Optional: provider keys
export OPENAI_API_KEY='...'
# or
export ANTHROPIC_API_KEY='...'

# Optional: enable MinerU ingest
export MINERU_ENABLED='true'
export MINERU_API_KEY='your_mineru_key'

# Generate config file template
pnpm cli init
```

Database tables are auto-migrated on first startup.

### Run

```bash
# Backend (dev mode, default port 3000)
pnpm cli dev

# Frontend (new terminal, default port 5173)
pnpm --dir web dev
```

Docker Compose example is available at `docker-compose.example.yml`.

## CLI

```bash
pnpm cli init                               # Generate agent.config.json
pnpm cli dev                                # Start dev server
pnpm cli run "your prompt" --session demo   # Create and execute run
pnpm cli run "your prompt" --stream         # Stream events in terminal
pnpm cli tail <run_id>                      # Tail run events
pnpm cli export <run_id> --format json      # Export trace
pnpm cli skills list                        # List registered skills
pnpm cli doctor                             # Health and dependency checks
```

## Web UI

| Page | Path | Description |
|------|------|-------------|
| Playground | `/` | Chat and task execution |
| Dashboard | `/dashboard` | Runtime health and metrics |
| Approvals Inbox | `/inbox` | Human approval queue |
| PA Emulator | `/emulator` | Simulated IM routing + traces |
| Runs | `/runs` | Run history and status |
| Trace | `/trace/:runId` | Step/event timeline |
| Swarm Studio | `/orchestrator` | Roles, groups, orchestration |
| Blackboard | `/blackboard` / `/blackboard/:groupId` | Shared team memory board |
| Skills | `/skills` | Skill registry management |
| Group Run | `/group-run/:runId` | Group run summary view |
| PDF Ingest | `/ingest` | MinerU batch PDF import |

## API

All business endpoints are under `/api`.

### Multi-tenancy Scope

Pass tenant scope via HTTP headers:

```bash
curl -H "x-org-id: my-org" \
     -H "x-user-id: my-user" \
     -H "x-project-id: my-project" \
     http://localhost:3000/api/runs
```

CLI env counterparts: `AGENT_ORG_ID`, `AGENT_USER_ID`, `AGENT_PROJECT_ID`.

### Health

```
GET    /health
```

### Runs

```
POST   /api/runs
GET    /api/runs/:run_id
GET    /api/sessions/:session_key/runs
GET    /api/runs/:run_id/events
GET    /api/runs/:run_id/stream
GET    /api/runs/:run_id/children
GET    /api/runs/:run_id/swarm
POST   /api/runs/:run_id/inject
POST   /api/runs/:run_id/cancel
POST   /api/runs/:run_id/approve
POST   /api/runs/:run_id/reject
```

### Roles

```
POST   /api/roles
GET    /api/roles
GET    /api/roles/:role_id
PUT    /api/roles/:role_id
DELETE /api/roles/:role_id
GET    /api/roles/:role_id/stats
POST   /api/roles/batch-delete
```

### Groups

```
POST   /api/groups
GET    /api/groups
POST   /api/groups/assign-project
GET    /api/groups/:group_id
PUT    /api/groups/:group_id
DELETE /api/groups/:group_id
GET    /api/groups/:group_id/stats
GET    /api/groups/:group_id/runs
POST   /api/groups/:group_id/members
GET    /api/groups/:group_id/members
PUT    /api/groups/:group_id/members/:member_id
DELETE /api/groups/:group_id/members/:member_id
POST   /api/groups/:group_id/runs
POST   /api/groups/batch-delete
```

### Blackboard & Skills

```
GET    /api/groups/:groupId/blackboard
GET    /api/groups/:groupId/blackboard/:memoryId
POST   /api/groups/:groupId/blackboard

POST   /api/skills
GET    /api/skills
GET    /api/skills/:skill_id
DELETE /api/skills/:skill_id
```

### Uploads & Integrations

```
POST   /api/uploads
GET    /api/uploads/:upload_id

POST   /api/feishu/connectors
GET    /api/feishu/connectors
GET    /api/feishu/connectors/:connector_id
PATCH  /api/feishu/connectors/:connector_id
POST   /api/feishu/connectors/:connector_id/sync
GET    /api/feishu/connectors/:connector_id/jobs

POST   /api/mineru/ingest-batch
GET    /api/mineru/ingest-batch/:jobId/progress
GET    /api/mineru/ingest-batch/:jobId
```

### Event Types (selected)

| Type | Description |
|------|-------------|
| `run.started` / `run.completed` / `run.failed` | Run lifecycle |
| `step.started` / `step.completed` | Step execution |
| `llm.called` / `llm.token` | LLM call + streaming tokens |
| `tool.called` / `tool.result` / `tool.blocked` | Tool invocation lifecycle |
| `tool.requires_approval` | HITL approval requested |
| `message.task` / `message.proposal` / `message.decision` | Orchestration messages |

## MinerU Batch PDF Ingest

Enable MinerU first (`MINERU_ENABLED=true` and `MINERU_API_KEY`). Then you can ingest multiple PDFs in one job:

```bash
curl -X POST "http://localhost:3000/api/mineru/ingest-batch" \
  -H "x-org-id: my-org" \
  -H "x-user-id: my-user" \
  -H "x-project-id: my-project" \
  -F "file=@./docs/spec-a.pdf" \
  -F "file=@./docs/spec-b.pdf" \
  -F "enable_table=true" \
  -F "enable_formula=true"
```

The response returns `job_id`. Subscribe to progress via SSE:

```bash
curl "http://localhost:3000/api/mineru/ingest-batch/<job_id>/progress"
```

## Configuration

Configuration priority: config file < env vars < CLI flags < API request parameters.

### Recent Changes (2026-03-02)

- Recent 10 commits mainly focused on repository refactor.
- Storage/repository layer was extracted from `src/backend/repository` into a standalone package: `src/packages/repository`.
- Added/adjusted repository interfaces, memory/postgres implementations, and Postgres migration wiring to match the new package boundary.

### Key Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `DATABASE_URL` | PostgreSQL connection string | (required) |
| `PORT` | Backend port | `3000` |
| `DATA_DIR` | Data directory for runtime artifacts | `data` |
| `LLM_PROVIDER` | `openai` / `anthropic` / `gemini` / `mock` | from config |
| `LLM_MODEL` | Model name | provider-specific |
| `LLM_API_KEY` | Unified provider key | — |
| `OPENAI_API_KEY` | OpenAI compatibility key | — |
| `ANTHROPIC_API_KEY` | Anthropic compatibility key | — |
| `EMBEDDING_PROVIDER` | `hash` / `api` | `hash` |
| `FEISHU_ENABLED` | Enable Feishu connector sync | `false` |
| `FEISHU_APP_ID` / `FEISHU_APP_SECRET` | Feishu app credentials | — |
| `FEISHU_POLL_INTERVAL_MS` | Connector polling interval | `120000` |
| `MINERU_ENABLED` | Enable MinerU ingest integration | `false` |
| `MINERU_API_KEY` | MinerU API token/AK-SK | — |
| `MINERU_BASE_URL` | MinerU API endpoint | `https://mineru.net/api/v4` |
| `MINERU_POLL_INTERVAL_MS` | MinerU job polling interval | `3000` |
| `MINERU_MAX_POLL_ATTEMPTS` | Max polling attempts per file | `120` |
| `MINERU_DEFAULT_MODEL_VERSION` | `pipeline` / `vlm` / `MinerU-HTML` | `pipeline` |
| `VITE_API_PROXY_TARGET` | Frontend dev proxy target | — |

## Project Structure

```
src/
├── backend/
│   ├── api/              # Express route handlers
│   ├── agent/            # LLM clients + MCP client
│   ├── db/               # PostgreSQL pool, migrations, schema
│   ├── queue/            # Run queue
│   ├── runtime/          # Core executor, tools, orchestration, integrations
│   └── store/            # Data access (events, memory, vectors)
├── cli/                  # CLI commands
├── config/               # Config loader
├── types/                # Shared schemas/types
└── utils/                # IDs, errors, logger
web/
├── src/
│   ├── api/              # REST client + SSE client
│   ├── components/       # React components
│   ├── pages/            # Route pages
│   ├── hooks/            # Custom hooks
│   ├── context/          # Context providers
│   └── i18n/             # Localization
└── e2e/                  # Playwright tests
python/                   # Optional MCP server
```

## Development

```bash
# Type check
pnpm typecheck
pnpm --dir web typecheck

# Lint
pnpm lint
pnpm --dir web lint

# Backend tests
pnpm test

# Frontend tests
pnpm --dir web test

# E2E (install browser once)
pnpm --dir web exec playwright install chromium
pnpm --dir web test:e2e

# Python MCP tests
cd python && pytest
```

## Troubleshooting

| Problem | Solution |
|---------|----------|
| `DATABASE_URL is required` | Set `export DATABASE_URL='postgres://...'` |
| `CREATE EXTENSION vector` permission error | Ask DBA to pre-install `vector` and `pgcrypto` |
| SSE returns 400/404 | Ensure `org/user/project` headers match run scope |
| MCP tools unavailable | `cd python && pip3 install -e .` |
| MinerU ingest returns `MinerU is not enabled` | Set `MINERU_ENABLED=true` and valid `MINERU_API_KEY` |

## License

TBD
