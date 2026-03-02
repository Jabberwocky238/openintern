/**
 * PostgreSQL schema statements for the runtime.
 *
 * Notes:
 * - `vector` extension is required for pgvector embeddings.
 * - `pgcrypto` is used for UUID generation.
 * - all statements are idempotent.
 */
export const POSTGRES_SCHEMA_STATEMENTS: string[] = [
  `CREATE EXTENSION IF NOT EXISTS vector`,
  `CREATE EXTENSION IF NOT EXISTS pgcrypto`,
  `CREATE TABLE IF NOT EXISTS runs (
    id TEXT PRIMARY KEY,
    org_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    project_id TEXT,
    session_key TEXT NOT NULL,
    input TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('pending', 'running', 'waiting', 'completed', 'failed', 'cancelled')),
    run_mode TEXT NOT NULL DEFAULT 'single' CHECK (run_mode IN ('single', 'group', 'plan_execute')),
    agent_id TEXT NOT NULL DEFAULT 'main',
    llm_config JSONB,
    result JSONB,
    error JSONB,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    started_at TIMESTAMPTZ,
    ended_at TIMESTAMPTZ,
    cancelled_at TIMESTAMPTZ
  )`,
  `CREATE INDEX IF NOT EXISTS runs_scope_created_idx
    ON runs (org_id, user_id, project_id, created_at DESC)`,
  `CREATE INDEX IF NOT EXISTS runs_scope_session_created_idx
    ON runs (org_id, user_id, project_id, session_key, created_at DESC)`,
  `CREATE TABLE IF NOT EXISTS events (
    id BIGSERIAL PRIMARY KEY,
    run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
    ts TIMESTAMPTZ NOT NULL,
    agent_id TEXT NOT NULL,
    step_id TEXT NOT NULL,
    type TEXT NOT NULL,
    payload JSONB NOT NULL DEFAULT '{}'::jsonb,
    v INTEGER NOT NULL DEFAULT 1,
    span_id TEXT NOT NULL,
    parent_span_id TEXT,
    redaction JSONB NOT NULL DEFAULT '{"contains_secrets": false}'::jsonb
  )`,
  `CREATE INDEX IF NOT EXISTS events_run_id_idx ON events (run_id, id)`,
  `CREATE INDEX IF NOT EXISTS events_run_ts_idx ON events (run_id, ts)`,
  `CREATE TABLE IF NOT EXISTS checkpoints (
    id BIGSERIAL PRIMARY KEY,
    run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
    agent_id TEXT NOT NULL,
    step_id TEXT NOT NULL,
    state JSONB NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`,
  `CREATE INDEX IF NOT EXISTS checkpoints_run_agent_idx
    ON checkpoints (run_id, agent_id, id DESC)`,
  `CREATE TABLE IF NOT EXISTS memories (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    project_id TEXT,
    type TEXT NOT NULL CHECK (type IN ('core', 'episodic', 'archival')),
    text TEXT NOT NULL,
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
    importance REAL NOT NULL DEFAULT 0.5,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`,
  `CREATE INDEX IF NOT EXISTS memories_scope_created_idx
    ON memories (org_id, user_id, project_id, created_at DESC)`,
  `CREATE TABLE IF NOT EXISTS memory_chunks (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    memory_id UUID NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
    org_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    project_id TEXT,
    chunk_index INTEGER NOT NULL,
    chunk_text TEXT NOT NULL,
    snippet TEXT NOT NULL,
    embedding VECTOR(256) NOT NULL,
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
    search_tsv TSVECTOR GENERATED ALWAYS AS (to_tsvector('simple', chunk_text)) STORED,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`,
  `CREATE INDEX IF NOT EXISTS memory_chunks_scope_idx
    ON memory_chunks (org_id, user_id, project_id, created_at DESC)`,
  `CREATE INDEX IF NOT EXISTS memory_chunks_memory_id_idx
    ON memory_chunks (memory_id, chunk_index)`,
  `CREATE INDEX IF NOT EXISTS memory_chunks_search_idx
    ON memory_chunks USING GIN (search_tsv)`,
  `CREATE INDEX IF NOT EXISTS memory_chunks_embedding_idx
    ON memory_chunks USING ivfflat (embedding vector_cosine_ops) WITH (lists = 100)`,

  // ─── Phase 0: Orchestrator tables ──────────────────────────

  `CREATE TABLE IF NOT EXISTS roles (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    system_prompt TEXT NOT NULL,
    allowed_tools JSONB NOT NULL DEFAULT '[]'::jsonb,
    denied_tools JSONB NOT NULL DEFAULT '[]'::jsonb,
    style_constraints JSONB NOT NULL DEFAULT '{}'::jsonb,
    is_lead BOOLEAN NOT NULL DEFAULT FALSE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`,

  `CREATE TABLE IF NOT EXISTS groups (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    project_id TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`,
  `CREATE INDEX IF NOT EXISTS groups_project_idx ON groups (project_id)`,

  `CREATE TABLE IF NOT EXISTS agent_instances (
    id TEXT PRIMARY KEY,
    role_id TEXT NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
    project_id TEXT,
    preferences JSONB NOT NULL DEFAULT '{}'::jsonb,
    state JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`,
  `CREATE INDEX IF NOT EXISTS agent_instances_role_idx ON agent_instances (role_id)`,
  `CREATE INDEX IF NOT EXISTS agent_instances_project_idx ON agent_instances (project_id)`,

  `CREATE TABLE IF NOT EXISTS group_members (
    id TEXT PRIMARY KEY,
    group_id TEXT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
    role_id TEXT NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
    agent_instance_id TEXT REFERENCES agent_instances(id) ON DELETE SET NULL,
    ordinal INTEGER NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`,
  `CREATE INDEX IF NOT EXISTS group_members_group_idx ON group_members (group_id, ordinal)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS group_members_group_role_idx ON group_members (group_id, role_id)`,

  // ─── Phase 2: Skills table ───────────────────────────────────

  `CREATE TABLE IF NOT EXISTS skills (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    tools JSONB NOT NULL DEFAULT '[]'::jsonb,
    risk_level TEXT NOT NULL DEFAULT 'low' CHECK (risk_level IN ('low', 'medium', 'high')),
    provider TEXT NOT NULL DEFAULT 'builtin' CHECK (provider IN ('builtin', 'mcp')),
    health_status TEXT NOT NULL DEFAULT 'unknown' CHECK (health_status IN ('healthy', 'unhealthy', 'unknown')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`,
  `CREATE INDEX IF NOT EXISTS skills_provider_idx ON skills (provider)`,
  `CREATE INDEX IF NOT EXISTS skills_risk_level_idx ON skills (risk_level)`,

  // Add group_id to runs table (idempotent)
  `DO $$ BEGIN
    IF NOT EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_name = 'runs' AND column_name = 'group_id'
    ) THEN
      ALTER TABLE runs ADD COLUMN group_id TEXT;
    END IF;
  END $$`,
  `CREATE INDEX IF NOT EXISTS runs_group_idx ON runs (group_id)`,

  // Add run_mode to runs table (idempotent)
  `DO $$ BEGIN
    IF NOT EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_name = 'runs' AND column_name = 'run_mode'
    ) THEN
      ALTER TABLE runs ADD COLUMN run_mode TEXT NOT NULL DEFAULT 'single';
    END IF;
  END $$`,
  `UPDATE runs
    SET run_mode = 'group'
    WHERE group_id IS NOT NULL
      AND run_mode = 'single'`,
  `DO $$ BEGIN
    IF NOT EXISTS (
      SELECT 1
      FROM pg_constraint
      WHERE conname = 'runs_run_mode_check_v1'
        AND conrelid = 'runs'::regclass
    ) THEN
      ALTER TABLE runs DROP CONSTRAINT IF EXISTS runs_run_mode_check;
      ALTER TABLE runs ADD CONSTRAINT runs_run_mode_check_v1
        CHECK (run_mode IN ('single', 'group', 'plan_execute'));
    END IF;
  END $$`,
  `CREATE INDEX IF NOT EXISTS runs_run_mode_idx ON runs (run_mode, created_at DESC)`,

  // Add group_id and message_type to events table (idempotent)
  `DO $$ BEGIN
    IF NOT EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_name = 'events' AND column_name = 'group_id'
    ) THEN
      ALTER TABLE events ADD COLUMN group_id TEXT;
    END IF;
  END $$`,
  `DO $$ BEGIN
    IF NOT EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_name = 'events' AND column_name = 'message_type'
    ) THEN
      ALTER TABLE events ADD COLUMN message_type TEXT;
    END IF;
  END $$`,

  // ─── Phase 3: Shared Blackboard + Personal Memory ─────────
  // Add group_id and agent_instance_id to memories table
  `DO $$ BEGIN
    IF NOT EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_name = 'memories' AND column_name = 'group_id'
    ) THEN
      ALTER TABLE memories ADD COLUMN group_id TEXT;
    END IF;
  END $$`,
  `DO $$ BEGIN
    IF NOT EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_name = 'memories' AND column_name = 'agent_instance_id'
    ) THEN
      ALTER TABLE memories ADD COLUMN agent_instance_id TEXT;
    END IF;
  END $$`,
  `CREATE INDEX IF NOT EXISTS memories_group_idx ON memories (group_id, created_at DESC)`,
  `CREATE INDEX IF NOT EXISTS memories_agent_instance_idx ON memories (agent_instance_id, created_at DESC)`,

  // Add group_id and agent_instance_id to memory_chunks table
  `DO $$ BEGIN
    IF NOT EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_name = 'memory_chunks' AND column_name = 'group_id'
    ) THEN
      ALTER TABLE memory_chunks ADD COLUMN group_id TEXT;
    END IF;
  END $$`,
  `DO $$ BEGIN
    IF NOT EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_name = 'memory_chunks' AND column_name = 'agent_instance_id'
    ) THEN
      ALTER TABLE memory_chunks ADD COLUMN agent_instance_id TEXT;
    END IF;
  END $$`,
  `CREATE INDEX IF NOT EXISTS memory_chunks_group_idx ON memory_chunks (group_id, created_at DESC)`,
  `CREATE INDEX IF NOT EXISTS memory_chunks_agent_instance_idx ON memory_chunks (agent_instance_id, created_at DESC)`,

  // Add metadata to memory_chunks table (idempotent)
  `DO $$ BEGIN
    IF NOT EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_name = 'memory_chunks' AND column_name = 'metadata'
    ) THEN
      ALTER TABLE memory_chunks ADD COLUMN metadata JSONB NOT NULL DEFAULT '{}'::jsonb;
    END IF;
  END $$`,

  // ─── Plugin: generic connector + jobs + key-value state ───
  `CREATE TABLE IF NOT EXISTS plugins (
    id TEXT PRIMARY KEY,
    provider TEXT NOT NULL,
    org_id TEXT NOT NULL,
    project_id TEXT NOT NULL,
    name TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('active', 'paused')),
    config JSONB NOT NULL DEFAULT '{}'::jsonb,
    state JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_by TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`,
  `CREATE INDEX IF NOT EXISTS plugins_provider_scope_idx
    ON plugins (provider, org_id, project_id, created_at DESC)`,
  `CREATE INDEX IF NOT EXISTS plugins_provider_status_idx
    ON plugins (provider, status)`,

  `CREATE TABLE IF NOT EXISTS plugin_jobs (
    id TEXT PRIMARY KEY,
    plugin_id TEXT NOT NULL REFERENCES plugins(id) ON DELETE CASCADE,
    org_id TEXT NOT NULL,
    project_id TEXT NOT NULL,
    kind TEXT NOT NULL DEFAULT 'sync',
    trigger TEXT NOT NULL CHECK (trigger IN ('manual', 'poll', 'webhook')),
    status TEXT NOT NULL CHECK (status IN ('pending', 'running', 'completed', 'failed')),
    started_at TIMESTAMPTZ,
    ended_at TIMESTAMPTZ,
    result JSONB NOT NULL DEFAULT '{}'::jsonb,
    error_message TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`,
  `CREATE INDEX IF NOT EXISTS plugin_jobs_plugin_idx
    ON plugin_jobs (plugin_id, created_at DESC)`,
  `CREATE INDEX IF NOT EXISTS plugin_jobs_scope_idx
    ON plugin_jobs (org_id, project_id, created_at DESC)`,

  `CREATE TABLE IF NOT EXISTS plugin_kv (
    plugin_id TEXT NOT NULL REFERENCES plugins(id) ON DELETE CASCADE,
    key TEXT NOT NULL,
    value JSONB NOT NULL DEFAULT '{}'::jsonb,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (plugin_id, key)
  )`,

  // ─── PA Escalation: parent_run_id + waiting status ─────────
  `DO $$ BEGIN
    IF NOT EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_name = 'runs' AND column_name = 'parent_run_id'
    ) THEN
      ALTER TABLE runs ADD COLUMN parent_run_id TEXT REFERENCES runs(id);
    END IF;
  END $$`,
  `CREATE INDEX IF NOT EXISTS runs_parent_run_id_idx ON runs (parent_run_id)`,

  // Update status CHECK constraint to include 'waiting' (idempotent)
  `DO $$ BEGIN
    IF NOT EXISTS (
      SELECT 1 FROM pg_constraint
      WHERE conname = 'runs_status_check_v2'
    ) THEN
      ALTER TABLE runs DROP CONSTRAINT IF EXISTS runs_status_check;
      ALTER TABLE runs ADD CONSTRAINT runs_status_check_v2
        CHECK (status IN ('pending', 'running', 'waiting', 'completed', 'failed', 'cancelled'));
    END IF;
  EXCEPTION
    WHEN check_violation THEN
      -- Legacy databases may already contain values introduced by later schema versions
      -- (e.g. 'suspended'). Skip v2 so v3/v4 reconciliation can continue.
      NULL;
  END $$`,

  // ─── Phase C: Permission Passthrough ─────────────────────────
  // Add delegated_permissions JSONB column to runs table (idempotent)
  `DO $$ BEGIN
    IF NOT EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_name = 'runs' AND column_name = 'delegated_permissions'
    ) THEN
      ALTER TABLE runs ADD COLUMN delegated_permissions JSONB;
    END IF;
  END $$`,

  // ─── Checkpoint v2: run_messages table ─────────────────────
  `CREATE TABLE IF NOT EXISTS run_messages (
    id BIGSERIAL PRIMARY KEY,
    run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
    agent_id TEXT NOT NULL,
    step_id TEXT NOT NULL,
    ordinal INTEGER NOT NULL,
    role TEXT NOT NULL CHECK (role IN ('user','assistant','system','tool')),
    content JSONB NOT NULL,
    tool_call_id TEXT,
    tool_calls JSONB,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`,
  `CREATE INDEX IF NOT EXISTS run_messages_run_agent_idx
    ON run_messages (run_id, agent_id, ordinal)`,

  // ─── Checkpoint v2: suspended status + columns ─────────────
  `DO $$ BEGIN
    IF NOT EXISTS (
      SELECT 1 FROM pg_constraint
      WHERE conname = 'runs_status_check_v3'
    ) THEN
      ALTER TABLE runs DROP CONSTRAINT IF EXISTS runs_status_check_v2;
      ALTER TABLE runs DROP CONSTRAINT IF EXISTS runs_status_check;
      ALTER TABLE runs ADD CONSTRAINT runs_status_check_v3
        CHECK (status IN ('pending', 'running', 'waiting', 'suspended', 'completed', 'failed', 'cancelled'));
    END IF;
  EXCEPTION
    WHEN check_violation THEN
      -- Keep migration moving; canonical v4 block below will rebuild safely.
      NULL;
  END $$`,
  `DO $$ BEGIN
    IF NOT EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_name = 'runs' AND column_name = 'suspended_at'
    ) THEN
      ALTER TABLE runs ADD COLUMN suspended_at TIMESTAMPTZ;
    END IF;
  END $$`,
  `DO $$ BEGIN
    IF NOT EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_name = 'runs' AND column_name = 'suspend_reason'
    ) THEN
      ALTER TABLE runs ADD COLUMN suspend_reason TEXT;
    END IF;
  END $$`,

  // ─── Self-heal: enforce canonical runs.status CHECK constraint ─────────
  // Some environments may carry legacy/mismatched constraint definitions
  // (e.g. runs_status_check_v2 with unexpected allowed values). Rebuild to v4.
  `DO $$ DECLARE
    constraint_name TEXT;
  BEGIN
    FOR constraint_name IN
      SELECT c.conname
      FROM pg_constraint c
      JOIN pg_class t ON t.oid = c.conrelid
      WHERE t.relname = 'runs'
        AND c.contype = 'c'
        AND (
          c.conname LIKE 'runs_status_check%'
          OR pg_get_constraintdef(c.oid) ILIKE '%status%'
        )
        AND c.conname <> 'runs_status_check_v4'
    LOOP
      EXECUTE format('ALTER TABLE runs DROP CONSTRAINT IF EXISTS %I', constraint_name);
    END LOOP;

    IF NOT EXISTS (
      SELECT 1
      FROM pg_constraint
      WHERE conname = 'runs_status_check_v4'
        AND conrelid = 'runs'::regclass
    ) THEN
      BEGIN
        ALTER TABLE runs ADD CONSTRAINT runs_status_check_v4
          CHECK (status IN ('pending', 'running', 'waiting', 'suspended', 'completed', 'failed', 'cancelled'));
      EXCEPTION
        WHEN check_violation THEN
          -- Keep existing legacy rows untouched for now but enforce the rule on new writes.
          ALTER TABLE runs ADD CONSTRAINT runs_status_check_v4
            CHECK (status IN ('pending', 'running', 'waiting', 'suspended', 'completed', 'failed', 'cancelled'))
            NOT VALID;
      END;
    END IF;
  END $$`,

  // ─── Phase 3: Event-Driven Dynamic Swarm ─────────────────
  `CREATE TABLE IF NOT EXISTS run_dependencies (
    id            BIGSERIAL PRIMARY KEY,
    parent_run_id TEXT NOT NULL REFERENCES runs(id),
    child_run_id  TEXT NOT NULL REFERENCES runs(id),
    tool_call_id  TEXT NOT NULL,
    role_id       TEXT,
    goal          TEXT NOT NULL,
    status        TEXT NOT NULL DEFAULT 'pending'
      CHECK (status IN ('pending','completed','failed')),
    result        TEXT,
    error         TEXT,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    completed_at  TIMESTAMPTZ,
    UNIQUE(parent_run_id, child_run_id)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_run_deps_parent ON run_dependencies(parent_run_id)`,
  `CREATE INDEX IF NOT EXISTS idx_run_deps_child  ON run_dependencies(child_run_id)`,

  // ─── Plan-and-Execute DAG tables ──────────────────────────
  `CREATE TABLE IF NOT EXISTS run_task_plans (
    id BIGSERIAL PRIMARY KEY,
    run_id TEXT NOT NULL UNIQUE REFERENCES runs(id) ON DELETE CASCADE,
    planner_model TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'planned'
      CHECK (status IN ('planned', 'running', 'completed', 'failed')),
    raw_plan JSONB NOT NULL DEFAULT '{}'::jsonb,
    failure_reason TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`,
  `CREATE INDEX IF NOT EXISTS run_task_plans_status_idx
    ON run_task_plans (status, created_at DESC)`,
  `CREATE TABLE IF NOT EXISTS run_task_items (
    id BIGSERIAL PRIMARY KEY,
    plan_id BIGINT NOT NULL REFERENCES run_task_plans(id) ON DELETE CASCADE,
    task_id TEXT NOT NULL,
    task_text TEXT NOT NULL,
    role_id TEXT NOT NULL,
    depends_on TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    layer_index INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'planned'
      CHECK (status IN ('planned', 'running', 'completed', 'failed')),
    context TEXT,
    acceptance TEXT,
    child_run_id TEXT REFERENCES runs(id) ON DELETE SET NULL,
    tool_call_id TEXT,
    output TEXT,
    error TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE(plan_id, task_id)
  )`,
  `CREATE INDEX IF NOT EXISTS run_task_items_plan_status_idx
    ON run_task_items (plan_id, status, layer_index ASC, id ASC)`,
  `CREATE INDEX IF NOT EXISTS run_task_items_child_idx
    ON run_task_items (child_run_id)`,
];
