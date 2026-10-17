-- Frozen schema of a store at version 56, the last one before migration 60 (versions 57 to 59 were never used).
-- Built by opening a fresh store and dumping sqlite_master without idx_memories_decay_key; never regenerate it,
-- so the migration chain is tested against a shape later migrations cannot change.

CREATE TABLE api_key_scope_grants (
          key_id     TEXT NOT NULL,
          scope      TEXT NOT NULL,
          granted_at TEXT NOT NULL,
          PRIMARY KEY(key_id, scope)
        );

CREATE TABLE api_keys (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          key_id TEXT UNIQUE NOT NULL,
          key_hash TEXT NOT NULL,
          tenant_id TEXT NOT NULL DEFAULT 'default',
          label TEXT,
          created_at TEXT NOT NULL,
          revoked_at TEXT
        , role TEXT NOT NULL DEFAULT 'admin', owner_subject TEXT, expires_at TEXT);

CREATE TABLE audit_log (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          ts TEXT NOT NULL,
          tenant_id TEXT NOT NULL DEFAULT 'default',
          actor TEXT NOT NULL,
          op TEXT NOT NULL,
          target_id TEXT,
          metadata_json TEXT NOT NULL DEFAULT '{}'
        );

CREATE TABLE card_comments (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          card_id TEXT NOT NULL REFERENCES cards(id),
          author TEXT NOT NULL,
          body TEXT NOT NULL,
          created_at TEXT NOT NULL,
          tenant_id TEXT NOT NULL DEFAULT 'default'
        );

CREATE TABLE card_deps (
          parent TEXT NOT NULL REFERENCES cards(id),
          child TEXT NOT NULL REFERENCES cards(id),
          tenant_id TEXT NOT NULL DEFAULT 'default',
          created_at TEXT NOT NULL,
          PRIMARY KEY (parent, child)
        ) WITHOUT ROWID;

CREATE TABLE card_runs (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          card TEXT NOT NULL REFERENCES cards(id),
          runtime TEXT NOT NULL,
          session_id TEXT,
          started TEXT NOT NULL,
          ended TEXT,
          outcome TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          tenant_id TEXT NOT NULL DEFAULT 'default'
        );

CREATE TABLE cards (
          id TEXT PRIMARY KEY,
          title TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'backlog',
          assignee_runtime TEXT,
          repo TEXT,
          contract TEXT,
          budget INTEGER,
          lease_until TEXT,
          heartbeat_at TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          tenant_id TEXT NOT NULL DEFAULT 'default',
          scope TEXT
        ) WITHOUT ROWID;

CREATE TABLE compactions (
          tenant_id       TEXT NOT NULL DEFAULT 'default',
          id              TEXT NOT NULL,
          session_id      TEXT NOT NULL,
          origin_project  TEXT NOT NULL DEFAULT '',
          compact_trigger TEXT,
          cwd             TEXT,
          transcript_path TEXT,
          snapshot_saved  INTEGER NOT NULL DEFAULT 0,
          started_at      TEXT NOT NULL,
          summarised_at   TEXT,
          summary         TEXT,
          items_json      TEXT,
          items_written   INTEGER NOT NULL DEFAULT 0,
          status          TEXT NOT NULL DEFAULT 'started' CHECK (status IN ('started','summarised','done','no-summary')), request_id TEXT,
          PRIMARY KEY (tenant_id, id)
        );

CREATE TABLE consolidation_runs (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          timestamp TEXT NOT NULL,
          decayed INTEGER NOT NULL,
          merged INTEGER NOT NULL,
          removed INTEGER NOT NULL
        , tenant_id TEXT NOT NULL DEFAULT 'default');

CREATE TABLE customer_notes (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            memory_id TEXT,
            tenant_id TEXT NOT NULL,
            customer TEXT NOT NULL,
            note TEXT NOT NULL,
            version INTEGER NOT NULL DEFAULT 1,
            status TEXT NOT NULL DEFAULT 'active'
              CHECK (status IN ('active', 'superseded', 'closed')),
            superseded_by INTEGER,
            superseded_at TEXT,
            change_summary TEXT,
            closed_at TEXT,
            created_at TEXT NOT NULL,
            FOREIGN KEY (memory_id) REFERENCES memories(id) ON DELETE SET NULL,
            FOREIGN KEY (superseded_by) REFERENCES customer_notes(id) ON DELETE SET NULL
          );

CREATE TABLE decisions (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            memory_id TEXT,
            tenant_id TEXT NOT NULL,
            decision_text TEXT NOT NULL,
            context TEXT,
            status TEXT NOT NULL DEFAULT 'active'
              CHECK (status IN ('active', 'superseded', 'closed')),
            superseded_by INTEGER,
            superseded_at TEXT,
            closed_at TEXT,
            created_at TEXT NOT NULL,
            FOREIGN KEY (memory_id) REFERENCES memories(id) ON DELETE SET NULL,
            FOREIGN KEY (superseded_by) REFERENCES decisions(id) ON DELETE SET NULL
          );

CREATE TABLE delivery_candidates (
          event_id     INTEGER NOT NULL REFERENCES delivery_events(id) ON DELETE CASCADE,
          tenant_id    TEXT NOT NULL DEFAULT 'default',
          memory_id    TEXT NOT NULL,          -- no FK: events outlive forgotten memories, as recall traces do
          source_store TEXT NOT NULL,
          pool         TEXT NOT NULL,
          stage        TEXT NOT NULL,
          outcome      TEXT NOT NULL,
          reason       TEXT,
          cand_rank    INTEGER,
          score        REAL,
          tokens       INTEGER,
          PRIMARY KEY (event_id, memory_id)
        ) WITHOUT ROWID;

CREATE TABLE delivery_events (
          id                INTEGER PRIMARY KEY AUTOINCREMENT,
          ts                TEXT NOT NULL,
          ledger_version    INTEGER NOT NULL,
          tenant_id         TEXT NOT NULL DEFAULT 'default',
          runtime           TEXT NOT NULL,
          event_type        TEXT NOT NULL,
          surface           TEXT NOT NULL,
          store_hash        TEXT NOT NULL,
          write_store       TEXT NOT NULL,
          project_hash      TEXT,
          session_id        TEXT,
          session_state     TEXT NOT NULL,
          host_turn_id      TEXT,
          turn_seq          INTEGER,
          duplicate_of      INTEGER,
          prompt_hash       TEXT,
          prompt_length     INTEGER NOT NULL DEFAULT 0,
          query_hash        TEXT,
          recall_trace_id   INTEGER,
          block_state       TEXT NOT NULL,
          prompt_recall     INTEGER NOT NULL DEFAULT 0,
          considered_count  INTEGER NOT NULL DEFAULT 0,
          filtered_count    INTEGER NOT NULL DEFAULT 0,
          selected_count    INTEGER NOT NULL DEFAULT 0,
          emitted_count     INTEGER NOT NULL DEFAULT 0,
          rejected_count    INTEGER NOT NULL DEFAULT 0,
          rejected_unlisted INTEGER NOT NULL DEFAULT 0,
          sections_shown    INTEGER NOT NULL DEFAULT 0,
          sections_dropped  INTEGER NOT NULL DEFAULT 0,
          budget_tokens     INTEGER NOT NULL DEFAULT 0,
          selected_tokens   INTEGER NOT NULL DEFAULT 0,
          injected_tokens   INTEGER NOT NULL DEFAULT 0,
          static_hash       TEXT,
          recall_hash       TEXT,
          emitted_hash      TEXT,
          elapsed_ms        INTEGER NOT NULL DEFAULT 0
        , tool_use_id TEXT, failure_id INTEGER);

CREATE TABLE dormant_memories (
          tenant_id  TEXT NOT NULL DEFAULT 'default',
          id         TEXT NOT NULL,
          content    TEXT NOT NULL,
          entry_json TEXT NOT NULL,
          reason     TEXT NOT NULL,
          strength   REAL NOT NULL,
          dormant_at TEXT NOT NULL,
          PRIMARY KEY (tenant_id, id)
        ) WITHOUT ROWID;

CREATE TABLE entities (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          tenant_id TEXT NOT NULL,
          entity_type TEXT NOT NULL
            CHECK (entity_type IN ('person', 'project', 'customer', 'system', 'policy', 'decision')),
          name TEXT NOT NULL,
          memory_id TEXT,
          source_kind TEXT NOT NULL CHECK (source_kind IN ('distilled', 'superseded')),
          source_object_type TEXT
            CHECK (source_object_type IS NULL OR source_object_type IN ('decision', 'policy', 'customer', 'project')),
          source_object_id INTEGER,
          created_at TEXT NOT NULL,
          FOREIGN KEY (memory_id) REFERENCES memories(id) ON DELETE SET NULL
        );

CREATE TABLE failure_log (
          id          INTEGER PRIMARY KEY AUTOINCREMENT,
          ts          TEXT NOT NULL,
          tenant_id   TEXT NOT NULL DEFAULT 'default',
          session_id  TEXT,
          tool        TEXT,
          outcome     TEXT NOT NULL,
          skip_rule   TEXT,
          sig_hash    TEXT,
          detail_hash TEXT
        , owner_subject TEXT, origin_project TEXT, request_id TEXT);

CREATE TABLE github_cursors (
          tenant_id TEXT NOT NULL,
          repo_full_name TEXT NOT NULL,
          issues_hwm TEXT,
          issue_comments_hwm TEXT,
          pr_review_comments_hwm TEXT,
          updated_at TEXT NOT NULL,
          PRIMARY KEY (tenant_id, repo_full_name)
        );

CREATE TABLE github_dlq (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          tenant_id TEXT NOT NULL,
          raw_payload TEXT NOT NULL,
          error TEXT NOT NULL,
          event_name TEXT,
          delivery_id TEXT,
          signature TEXT,
          installation_id TEXT,
          repo_full_name TEXT,
          retry_count INTEGER NOT NULL DEFAULT 0,
          received_at TEXT NOT NULL,
          retried_at TEXT,
          bucket TEXT NOT NULL DEFAULT 'parse_error'
        );

CREATE TABLE github_event_log (
          idempotency_key TEXT PRIMARY KEY,
          delivery_id TEXT NOT NULL,
          event_name TEXT NOT NULL,
          ingested_at TEXT NOT NULL,
          memory_id TEXT
        );

CREATE TABLE github_installations (
          installation_id TEXT PRIMARY KEY,
          tenant_id TEXT NOT NULL,
          added_at TEXT NOT NULL
        );

CREATE TABLE github_repositories (
          repo_full_name TEXT NOT NULL,
          tenant_id TEXT NOT NULL,
          added_at TEXT NOT NULL,
          PRIMARY KEY (repo_full_name, tenant_id)
        );

CREATE TABLE goal_recall_log (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          goal_id TEXT NOT NULL REFERENCES goal_stack(id) ON DELETE CASCADE,
          memory_id TEXT NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
          tenant_id TEXT NOT NULL DEFAULT 'default',
          session_id TEXT NOT NULL,
          recalled_at TEXT NOT NULL,
          score REAL NOT NULL
        );

CREATE TABLE goal_stack (
          id TEXT PRIMARY KEY,
          session_id TEXT NOT NULL,
          tenant_id TEXT NOT NULL DEFAULT 'default',
          goal_name TEXT NOT NULL,
          level INTEGER NOT NULL DEFAULT 0
            CHECK (level BETWEEN 0 AND 2),
          parent_goal_id TEXT REFERENCES goal_stack(id) ON DELETE SET NULL,
          status TEXT NOT NULL CHECK (status IN ('active','suspended','completed')),
          success_condition TEXT,
          retrieval_policy_id TEXT,
          created_at TEXT NOT NULL,
          completed_at TEXT,
          outcome_score REAL
            CHECK (outcome_score IS NULL OR (outcome_score >= 0 AND outcome_score <= 1))
        );

CREATE TABLE graph_extraction_queue (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            tenant_id TEXT NOT NULL,
            memory_id TEXT NOT NULL,
            kind TEXT NOT NULL CHECK (kind IN ('distilled', 'superseded')),
            status TEXT NOT NULL DEFAULT 'pending'
              CHECK (status IN ('pending', 'processed', 'skipped')),
            enqueued_at TEXT NOT NULL,
            processed_at TEXT,
            FOREIGN KEY (memory_id) REFERENCES memories(id) ON DELETE CASCADE
          );

CREATE TABLE incidents (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            memory_id TEXT,
            tenant_id TEXT NOT NULL,
            incident_text TEXT NOT NULL,
            context TEXT,
            status TEXT NOT NULL DEFAULT 'open'
              CHECK (status IN ('open', 'resolved', 'closed')),
            resolution_text TEXT,
            resolved_at TEXT,
            closed_at TEXT,
            linked_memory_ids TEXT NOT NULL DEFAULT '[]',
            created_at TEXT NOT NULL,
            FOREIGN KEY (memory_id) REFERENCES memories(id) ON DELETE SET NULL
          );

CREATE TABLE memories (
          id TEXT PRIMARY KEY,
          created TEXT NOT NULL,
          last_retrieved TEXT NOT NULL,
          retrieval_count INTEGER NOT NULL,
          strength REAL NOT NULL,
          half_life_days REAL NOT NULL,
          layer TEXT NOT NULL,
          tags_json TEXT NOT NULL,
          emotional_valence TEXT NOT NULL,
          schema_fit REAL NOT NULL,
          source TEXT NOT NULL,
          outcome_score REAL,
          conflicts_with_json TEXT NOT NULL,
          pinned INTEGER NOT NULL,
          confidence TEXT NOT NULL,
          content TEXT NOT NULL,
          updated_at TEXT NOT NULL DEFAULT (datetime('now'))
        , outcome_positive INTEGER NOT NULL DEFAULT 0, outcome_negative INTEGER NOT NULL DEFAULT 0, parents_json TEXT NOT NULL DEFAULT '[]', starred INTEGER NOT NULL DEFAULT 0, trace_outcome TEXT, source_session_id TEXT, valid_from TEXT, superseded_by TEXT, extracted_from TEXT, dag_level INTEGER NOT NULL DEFAULT 0, dag_parent_id TEXT, kind TEXT DEFAULT 'distilled', scope TEXT, owner TEXT, artifact_ref TEXT, tenant_id TEXT NOT NULL DEFAULT 'default', descendant_count INTEGER NOT NULL DEFAULT 0, earliest_at TEXT, latest_at TEXT, summary_dirty INTEGER NOT NULL DEFAULT 0, last_rebuilt_at TEXT, rebuild_count INTEGER NOT NULL DEFAULT 0, dag_level_3_built_at TEXT, origin_project TEXT);

CREATE VIRTUAL TABLE memories_fts USING fts5(id UNINDEXED, content, tags);

CREATE TABLE memory_conflicts (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          memory_a_id TEXT NOT NULL,
          memory_b_id TEXT NOT NULL,
          reason TEXT NOT NULL,
          score REAL NOT NULL DEFAULT 0,
          status TEXT NOT NULL,
          detected_at TEXT NOT NULL,
          updated_at TEXT NOT NULL, tenant_id TEXT NOT NULL DEFAULT 'default',
          UNIQUE(memory_a_id, memory_b_id)
        );

CREATE TABLE memory_physics (
      memory_id TEXT PRIMARY KEY REFERENCES memories(id) ON DELETE CASCADE,
      position_blob BLOB NOT NULL,
      velocity_blob BLOB NOT NULL,
      mass REAL NOT NULL,
      charge REAL NOT NULL,
      temperature REAL NOT NULL,
      last_simulation TEXT NOT NULL,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

CREATE TABLE memory_quarantine (
      tenant_id      TEXT NOT NULL DEFAULT 'default',
      memory_id      TEXT NOT NULL,
      original_scope TEXT,
      reason         TEXT NOT NULL,
      status         TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected')),
      quarantined_at TEXT NOT NULL,
      decided_at     TEXT,
      decided_by     TEXT,
      PRIMARY KEY (tenant_id, memory_id)
    ) WITHOUT ROWID;

CREATE TABLE memory_vectors (
    memory_id TEXT PRIMARY KEY,
    model     TEXT NOT NULL,
    dim       INTEGER NOT NULL,
    vector    BLOB NOT NULL
  );

CREATE TABLE meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

CREATE TABLE policies (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            memory_id TEXT,
            tenant_id TEXT NOT NULL,
            policy_name TEXT NOT NULL,
            policy_text TEXT NOT NULL,
            valid_from TEXT NOT NULL,
            valid_to TEXT,
            version INTEGER NOT NULL DEFAULT 1,
            status TEXT NOT NULL DEFAULT 'active'
              CHECK (status IN ('active', 'superseded', 'closed')),
            superseded_by INTEGER,
            superseded_at TEXT,
            change_summary TEXT,
            closed_at TEXT,
            created_at TEXT NOT NULL,
            FOREIGN KEY (memory_id) REFERENCES memories(id) ON DELETE SET NULL,
            FOREIGN KEY (superseded_by) REFERENCES policies(id) ON DELETE SET NULL
          );

CREATE TABLE predictions (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            memory_id TEXT,
            tenant_id TEXT NOT NULL,
            class_tag TEXT NOT NULL,
            claim_text TEXT NOT NULL,
            estimate_value REAL,
            estimate_unit TEXT,
            target_date TEXT,
            actual_value REAL,
            closure_state TEXT NOT NULL DEFAULT 'open'
              CHECK (closure_state IN ('open', 'closed', 'closed-unknown')),
            closed_at TEXT,
            closure_note TEXT,
            created_at TEXT NOT NULL,
            FOREIGN KEY (memory_id) REFERENCES memories(id) ON DELETE SET NULL
          );

CREATE TABLE processes (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            memory_id TEXT,
            tenant_id TEXT NOT NULL,
            process_name TEXT NOT NULL,
            description TEXT,
            steps TEXT NOT NULL DEFAULT '[]',
            version INTEGER NOT NULL DEFAULT 1,
            status TEXT NOT NULL DEFAULT 'active'
              CHECK (status IN ('active', 'superseded', 'closed')),
            superseded_by INTEGER,
            superseded_at TEXT,
            change_summary TEXT,
            closed_at TEXT,
            created_at TEXT NOT NULL,
            FOREIGN KEY (memory_id) REFERENCES memories(id) ON DELETE SET NULL,
            FOREIGN KEY (superseded_by) REFERENCES processes(id) ON DELETE SET NULL
          );

CREATE TABLE project_briefs (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            memory_id TEXT,
            tenant_id TEXT NOT NULL,
            repo TEXT NOT NULL,
            summary TEXT NOT NULL,
            version INTEGER NOT NULL DEFAULT 1,
            status TEXT NOT NULL DEFAULT 'active'
              CHECK (status IN ('active', 'superseded', 'closed')),
            superseded_by INTEGER,
            superseded_at TEXT,
            change_summary TEXT,
            closed_at TEXT,
            created_at TEXT NOT NULL,
            FOREIGN KEY (memory_id) REFERENCES memories(id) ON DELETE SET NULL,
            FOREIGN KEY (superseded_by) REFERENCES project_briefs(id) ON DELETE SET NULL
          );

CREATE TABLE raw_archive (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          memory_id TEXT NOT NULL,
          archived_at TEXT NOT NULL,
          reason TEXT NOT NULL,
          archived_by TEXT,
          payload_json TEXT NOT NULL
        , mirror_cleaned_at TEXT);

CREATE TABLE recall_trace_outcomes (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          trace_id INTEGER NOT NULL REFERENCES recall_traces(id) ON DELETE CASCADE,
          ts TEXT NOT NULL,
          tenant_id TEXT NOT NULL DEFAULT 'default',
          outcome TEXT NOT NULL CHECK (outcome IN ('positive','negative')),
          memory_ids_json TEXT NOT NULL      -- ids actually credited by this outcome event
        );

CREATE TABLE recall_trace_results (
          trace_id INTEGER NOT NULL REFERENCES recall_traces(id) ON DELETE CASCADE,
          tenant_id TEXT NOT NULL DEFAULT 'default',  -- denormalized like goal_recall_log (v18
                                                      -- precedent): tenant-scoped training queries
                                                      -- over the memory index must not need a join
                                                      -- back through recall_traces
          memory_id TEXT NOT NULL,           -- NO FK to memories: traces must OUTLIVE forgotten
                                             -- memories (they are LC2's negative class). PRAGMA
                                             -- foreign_keys=ON is real, so an FK would either
                                             -- block inserts or cascade-delete exactly the rows
                                             -- training needs. Deliberate.
          result_rank INTEGER NOT NULL,      -- NOT "rank" (SQL keyword; audit rule 10)
          score REAL NOT NULL,
          rerank_json TEXT,                  -- compact RerankStep[] when explain/trace present; else NULL
          PRIMARY KEY (trace_id, result_rank)
        ) WITHOUT ROWID;

CREATE TABLE recall_traces (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          ts TEXT NOT NULL,
          tenant_id TEXT NOT NULL DEFAULT 'default',
          session_id TEXT,
          pipeline TEXT NOT NULL CHECK (pipeline IN ('api','cli','context','mcp')),
            -- 'mcp' reserved for the deferred MCP wire-up. Deliberate: SQLite
            -- cannot ALTER a CHECK constraint, so extending it later means a
            -- full table-rebuild migration. One unused enum value now is
            -- cheaper than that rebuild.
          query_hash TEXT NOT NULL,          -- sha256/16, NEVER raw query (audit convention, cli.ts:1532)
          query_length INTEGER NOT NULL,
          result_count INTEGER NOT NULL,
          explain_mode INTEGER NOT NULL DEFAULT 0
        );

CREATE TABLE rejected_values (
          tenant_id  TEXT NOT NULL,
          digest     TEXT NOT NULL,            -- sha256/64 of normalized content
          reason     TEXT,                     -- human-supplied; the only description stored
          rejected_by TEXT,                    -- actor ('user:<id>' / 'cli' / ...)
          rejected_at TEXT NOT NULL,
          source_memory_id TEXT,               -- provenance only; NO FK (tombstone outlives the row)
          normalized_chars INTEGER,            -- weak sanity aid for humans listing tombstones
          PRIMARY KEY (tenant_id, digest)
        ) WITHOUT ROWID;

CREATE TABLE relations (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          tenant_id TEXT NOT NULL,
          from_entity_id INTEGER NOT NULL,
          to_entity_id INTEGER NOT NULL,
          rel_type TEXT NOT NULL
            CHECK (rel_type IN ('owns', 'supersedes', 'depends-on', 'blocked-by', 'references')),
          memory_id TEXT,
          source_kind TEXT NOT NULL CHECK (source_kind IN ('distilled', 'superseded')),
          source_object_type TEXT
            CHECK (source_object_type IS NULL OR source_object_type IN ('decision', 'policy', 'customer', 'project')),
          source_object_id INTEGER,
          created_at TEXT NOT NULL,
          FOREIGN KEY (from_entity_id) REFERENCES entities(id) ON DELETE CASCADE,
          FOREIGN KEY (to_entity_id) REFERENCES entities(id) ON DELETE CASCADE,
          FOREIGN KEY (memory_id) REFERENCES memories(id) ON DELETE SET NULL
        );

CREATE TABLE retrieval_policy (
          id TEXT PRIMARY KEY,
          goal_id TEXT NOT NULL REFERENCES goal_stack(id) ON DELETE CASCADE,
          policy_type TEXT NOT NULL CHECK (policy_type IN
            ('schema-fit-biased','error-prioritized','recency-first','hybrid')),
          weight_schema_fit REAL NOT NULL DEFAULT 1.0
            CHECK (weight_schema_fit >= 0 AND weight_schema_fit <= 100),
          weight_recency REAL NOT NULL DEFAULT 1.0
            CHECK (weight_recency >= 0 AND weight_recency <= 100),
          weight_outcome REAL NOT NULL DEFAULT 1.0
            CHECK (weight_outcome >= 0 AND weight_outcome <= 100),
          error_priority REAL NOT NULL DEFAULT 1.0
            CHECK (error_priority >= 0 AND error_priority <= 100)
        );

CREATE TABLE session_events (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          session_id TEXT NOT NULL,
          task TEXT,
          event_type TEXT NOT NULL,
          content TEXT NOT NULL,
          source TEXT NOT NULL,
          metadata_json TEXT NOT NULL,
          created_at TEXT NOT NULL
        , tenant_id TEXT NOT NULL DEFAULT 'default', scope TEXT);

CREATE TABLE session_handoffs (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          session_id TEXT NOT NULL,
          repo_root TEXT,
          task_id TEXT,
          summary TEXT NOT NULL,
          next_action TEXT,
          artifacts_json TEXT NOT NULL DEFAULT '[]',
          created_at TEXT NOT NULL
        , tenant_id TEXT NOT NULL DEFAULT 'default', scope TEXT, constraints_json TEXT, evidence_json TEXT, outcome TEXT, target_runtime TEXT, card_id TEXT, owner_subject TEXT, origin_project TEXT);

CREATE TABLE session_owners (
      tenant_id TEXT NOT NULL,
      session_id TEXT NOT NULL,
      owner_subject TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY (tenant_id, session_id)
    );

CREATE TABLE skills (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            memory_id TEXT,
            tenant_id TEXT NOT NULL,
            skill_name TEXT NOT NULL,
            instructions TEXT NOT NULL,
            trigger_text TEXT,
            version INTEGER NOT NULL DEFAULT 1,
            status TEXT NOT NULL DEFAULT 'active'
              CHECK (status IN ('active', 'superseded', 'closed')),
            superseded_by INTEGER,
            superseded_at TEXT,
            change_summary TEXT,
            closed_at TEXT,
            created_at TEXT NOT NULL,
            FOREIGN KEY (memory_id) REFERENCES memories(id) ON DELETE SET NULL,
            FOREIGN KEY (superseded_by) REFERENCES skills(id) ON DELETE SET NULL
          );

CREATE TABLE slack_cursors (
          tenant_id TEXT NOT NULL,
          channel_id TEXT NOT NULL,
          latest_ts TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          PRIMARY KEY (tenant_id, channel_id)
        );

CREATE TABLE slack_dlq (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          tenant_id TEXT NOT NULL,
          raw_payload TEXT NOT NULL,
          error TEXT NOT NULL,
          received_at TEXT NOT NULL,
          retried_at TEXT
        , team_id TEXT, bucket TEXT NOT NULL DEFAULT 'parse_error', retry_count INTEGER NOT NULL DEFAULT 0, signature TEXT, slack_timestamp TEXT);

CREATE TABLE slack_event_log (
          event_id TEXT PRIMARY KEY,
          ingested_at TEXT NOT NULL,
          memory_id TEXT
        );

CREATE TABLE slack_workspaces (
          team_id TEXT PRIMARY KEY,
          tenant_id TEXT NOT NULL,
          added_at TEXT NOT NULL
        );

CREATE TABLE task_snapshots (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          task TEXT NOT NULL,
          summary TEXT NOT NULL,
          next_step TEXT NOT NULL,
          status TEXT NOT NULL,
          source TEXT NOT NULL,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        , session_id TEXT, tenant_id TEXT NOT NULL DEFAULT 'default', scope TEXT, owner_subject TEXT, origin_project TEXT);

CREATE TABLE token_ledger (
          id         INTEGER PRIMARY KEY AUTOINCREMENT,
          ts         TEXT NOT NULL,
          tenant_id  TEXT NOT NULL DEFAULT 'default',
          session_id TEXT,
          surface    TEXT NOT NULL,
          event      TEXT NOT NULL,
          items      INTEGER NOT NULL DEFAULT 0,
          tokens     INTEGER NOT NULL DEFAULT 0,
          block_hash TEXT
        );

CREATE TABLE working_memory (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          scope TEXT NOT NULL,
          session_id TEXT,
          task_id TEXT,
          importance REAL NOT NULL DEFAULT 0,
          content TEXT NOT NULL,
          metadata_json TEXT NOT NULL DEFAULT '{}',
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        , tenant_id TEXT NOT NULL DEFAULT 'default');

CREATE INDEX idx_api_keys_live_owner ON api_keys(tenant_id, owner_subject) WHERE revoked_at IS NULL;

CREATE INDEX idx_api_keys_tenant_active
        ON api_keys(tenant_id) WHERE revoked_at IS NULL;

CREATE INDEX idx_audit_log_tenant_ts ON audit_log(tenant_id, ts DESC);

CREATE INDEX idx_card_comments_tenant_card
          ON card_comments(tenant_id, card_id, created_at DESC);

CREATE INDEX idx_card_deps_tenant_child
          ON card_deps(tenant_id, child);

CREATE INDEX idx_card_deps_tenant_parent
          ON card_deps(tenant_id, parent);

CREATE INDEX idx_card_runs_tenant_card
          ON card_runs(tenant_id, card, started DESC);

CREATE INDEX idx_cards_tenant_status
          ON cards(tenant_id, status, updated_at DESC);

CREATE UNIQUE INDEX idx_compactions_request ON compactions(tenant_id, request_id) WHERE request_id IS NOT NULL;

CREATE INDEX idx_compactions_session
          ON compactions(tenant_id, session_id, started_at);

CREATE INDEX idx_compactions_status
          ON compactions(tenant_id, status);

CREATE INDEX idx_consolidation_runs_tenant_ts ON consolidation_runs(tenant_id, timestamp DESC);

CREATE INDEX idx_customer_notes_customer
          ON customer_notes(tenant_id, customer, status);

CREATE INDEX idx_customer_notes_memory
          ON customer_notes(memory_id) WHERE memory_id IS NOT NULL;

CREATE INDEX idx_customer_notes_tenant_status
          ON customer_notes(tenant_id, status);

CREATE INDEX idx_customer_notes_tenant_status_created ON customer_notes(tenant_id, status, created_at DESC, id DESC);

CREATE INDEX idx_decisions_memory
          ON decisions(memory_id) WHERE memory_id IS NOT NULL;

CREATE INDEX idx_decisions_tenant_status
          ON decisions(tenant_id, status);

CREATE INDEX idx_decisions_tenant_status_created ON decisions(tenant_id, status, created_at DESC, id DESC);

CREATE INDEX idx_delivery_events_session ON delivery_events(tenant_id, session_id, id);

CREATE UNIQUE INDEX idx_delivery_events_tool_call
        ON delivery_events(tenant_id, session_id, tool_use_id)
        WHERE tool_use_id IS NOT NULL AND turn_seq IS NOT NULL;

CREATE INDEX idx_delivery_events_ts ON delivery_events(ts);

CREATE UNIQUE INDEX idx_delivery_events_turn
          ON delivery_events(tenant_id, session_id, event_type, turn_seq) WHERE turn_seq IS NOT NULL;

CREATE INDEX idx_dormant_memories_tenant_time
          ON dormant_memories(tenant_id, dormant_at DESC);

CREATE INDEX idx_entities_memory ON entities(memory_id);

CREATE INDEX idx_entities_source_object ON entities(source_object_type, source_object_id) WHERE source_object_id IS NOT NULL;

CREATE INDEX idx_entities_tenant ON entities(tenant_id);

CREATE UNIQUE INDEX idx_failure_log_request ON failure_log(tenant_id, request_id) WHERE request_id IS NOT NULL;

CREATE INDEX idx_failure_log_tenant
          ON failure_log(tenant_id, id);

CREATE INDEX idx_failure_log_ts
          ON failure_log(ts);

CREATE INDEX idx_github_dlq_tenant_received ON github_dlq(tenant_id, received_at);

CREATE INDEX idx_github_event_log_delivery ON github_event_log(delivery_id);

CREATE INDEX idx_github_event_log_memory ON github_event_log(memory_id) WHERE memory_id IS NOT NULL;

CREATE INDEX idx_goal_recall_log_goal
          ON goal_recall_log(goal_id);

CREATE INDEX idx_goal_stack_tenant_session_status
          ON goal_stack(tenant_id, session_id, status, created_at);

CREATE INDEX idx_graph_queue_status ON graph_extraction_queue(tenant_id, status);

CREATE INDEX idx_incidents_memory
          ON incidents(memory_id) WHERE memory_id IS NOT NULL;

CREATE INDEX idx_incidents_tenant_status
          ON incidents(tenant_id, status);

CREATE INDEX idx_incidents_tenant_status_created ON incidents(tenant_id, status, created_at DESC, id DESC);

CREATE INDEX idx_memories_created_drift
          ON memories(tenant_id) WHERE superseded_by IS NULL AND (length(created) <> 24 OR created NOT LIKE '%Z');

CREATE INDEX idx_memories_current ON memories(layer, created) WHERE superseded_by IS NULL;

CREATE INDEX idx_memories_dag_parent ON memories(dag_parent_id) WHERE dag_parent_id IS NOT NULL;

CREATE INDEX idx_memories_extracted_from ON memories(extracted_from) WHERE extracted_from IS NOT NULL;

CREATE INDEX idx_memories_last_retrieved ON memories(last_retrieved);

CREATE INDEX idx_memories_layer_created ON memories(layer, created);

CREATE INDEX idx_memories_pinned
          ON memories(tenant_id, created, id) WHERE pinned = 1;

CREATE INDEX idx_memories_scope ON memories(scope) WHERE scope IS NOT NULL;

CREATE INDEX idx_memories_source_session_id
        ON memories(source_session_id) WHERE source_session_id IS NOT NULL;

CREATE INDEX idx_memories_source_tenant_created ON memories(source, tenant_id, created, id);

CREATE INDEX idx_memories_tenant_created ON memories(tenant_id, created);

CREATE INDEX idx_memory_conflicts_status_updated
        ON memory_conflicts(status, updated_at DESC, id DESC);

CREATE INDEX idx_memory_physics_mass
    ON memory_physics(mass DESC);

CREATE INDEX idx_memory_quarantine_status
      ON memory_quarantine(tenant_id, status, quarantined_at DESC);

CREATE INDEX idx_policies_asof
          ON policies(tenant_id, valid_from);

CREATE INDEX idx_policies_memory
          ON policies(memory_id) WHERE memory_id IS NOT NULL;

CREATE INDEX idx_policies_tenant_status
          ON policies(tenant_id, status);

CREATE INDEX idx_policies_tenant_status_created ON policies(tenant_id, status, created_at DESC, id DESC);

CREATE INDEX idx_predictions_memory
          ON predictions(memory_id) WHERE memory_id IS NOT NULL;

CREATE INDEX idx_predictions_tenant_class
          ON predictions(tenant_id, class_tag, closure_state);

CREATE INDEX idx_processes_memory
          ON processes(memory_id) WHERE memory_id IS NOT NULL;

CREATE INDEX idx_processes_tenant_status
          ON processes(tenant_id, status);

CREATE INDEX idx_processes_tenant_status_created ON processes(tenant_id, status, created_at DESC, id DESC);

CREATE INDEX idx_project_briefs_memory
          ON project_briefs(memory_id) WHERE memory_id IS NOT NULL;

CREATE INDEX idx_project_briefs_repo
          ON project_briefs(tenant_id, repo, status);

CREATE INDEX idx_project_briefs_tenant_status
          ON project_briefs(tenant_id, status);

CREATE INDEX idx_project_briefs_tenant_status_created ON project_briefs(tenant_id, status, created_at DESC, id DESC);

CREATE UNIQUE INDEX idx_raw_archive_id_at
        ON raw_archive(memory_id, archived_at);

CREATE INDEX idx_raw_archive_memory_id ON raw_archive(memory_id);

CREATE INDEX idx_recall_trace_outcomes_trace ON recall_trace_outcomes(trace_id);

CREATE INDEX idx_recall_trace_results_tenant_memory
          ON recall_trace_results(tenant_id, memory_id);

CREATE INDEX idx_recall_traces_tenant_ts ON recall_traces(tenant_id, ts DESC);

CREATE INDEX idx_relations_from ON relations(from_entity_id);

CREATE INDEX idx_relations_memory ON relations(memory_id);

CREATE INDEX idx_relations_source_object ON relations(source_object_type, source_object_id) WHERE source_object_id IS NOT NULL;

CREATE INDEX idx_relations_tenant ON relations(tenant_id);

CREATE INDEX idx_relations_to ON relations(to_entity_id);

CREATE INDEX idx_retrieval_policy_goal
          ON retrieval_policy(goal_id);

CREATE INDEX idx_session_events_session_created
        ON session_events(session_id, created_at DESC, id DESC);

CREATE INDEX idx_session_events_task_created
        ON session_events(task, created_at DESC, id DESC);

CREATE INDEX idx_session_events_tenant_session ON session_events(tenant_id, session_id, created_at DESC, id DESC);

CREATE INDEX idx_session_handoffs_owner ON session_handoffs(tenant_id, owner_subject, origin_project, created_at DESC);

CREATE INDEX idx_session_handoffs_session
        ON session_handoffs(session_id, created_at DESC);

CREATE INDEX idx_session_handoffs_tenant_card
          ON session_handoffs(tenant_id, card_id, created_at DESC);

CREATE INDEX idx_session_handoffs_tenant_outcome ON session_handoffs(tenant_id, outcome, created_at DESC);

CREATE INDEX idx_session_handoffs_tenant_session ON session_handoffs(tenant_id, session_id, created_at DESC);

CREATE INDEX idx_skills_memory
          ON skills(memory_id) WHERE memory_id IS NOT NULL;

CREATE INDEX idx_skills_tenant_status
          ON skills(tenant_id, status);

CREATE INDEX idx_skills_tenant_status_created ON skills(tenant_id, status, created_at DESC, id DESC);

CREATE INDEX idx_slack_dlq_tenant_received ON slack_dlq(tenant_id, received_at);

CREATE INDEX idx_slack_event_log_memory ON slack_event_log(memory_id) WHERE memory_id IS NOT NULL;

CREATE INDEX idx_task_snapshots_owner ON task_snapshots(tenant_id, owner_subject, origin_project, status, updated_at DESC);

CREATE INDEX idx_task_snapshots_status_updated
        ON task_snapshots(status, updated_at DESC, id DESC);

CREATE INDEX idx_task_snapshots_tenant_scope ON task_snapshots(tenant_id, scope, status);

CREATE INDEX idx_task_snapshots_tenant_status ON task_snapshots(tenant_id, status, updated_at DESC);

CREATE INDEX idx_token_ledger_session
          ON token_ledger(tenant_id, session_id, surface, id DESC);

CREATE INDEX idx_token_ledger_ts
          ON token_ledger(ts);

CREATE INDEX idx_working_memory_scope
        ON working_memory(scope, importance DESC, created_at DESC);

CREATE INDEX idx_working_memory_session
        ON working_memory(session_id, created_at DESC);

CREATE INDEX idx_working_memory_tenant ON working_memory(tenant_id, importance DESC, created_at DESC);

CREATE UNIQUE INDEX uniq_goal_recall_log_memory_goal
          ON goal_recall_log(memory_id, goal_id);

CREATE TRIGGER trg_customer_notes_supersede_tenant_match_update
          BEFORE UPDATE ON customer_notes
          WHEN NEW.superseded_by IS NOT NULL
            AND NEW.superseded_by IS NOT OLD.superseded_by
          BEGIN
            SELECT CASE
              WHEN NEW.tenant_id != (SELECT tenant_id FROM customer_notes WHERE id = NEW.superseded_by)
              THEN RAISE(ABORT, 'customer_notes.superseded_by must reference a customer_note in the same tenant')
            END;
          END;

CREATE TRIGGER trg_customer_notes_tenant_match_insert
          BEFORE INSERT ON customer_notes
          WHEN NEW.memory_id IS NOT NULL
          BEGIN
            SELECT CASE
              WHEN NEW.tenant_id != (SELECT tenant_id FROM memories WHERE id = NEW.memory_id)
              THEN RAISE(ABORT, 'customer_notes.tenant_id must match memories.tenant_id for the referenced memory')
            END;
          END;

CREATE TRIGGER trg_customer_notes_tenant_match_update
          BEFORE UPDATE ON customer_notes
          WHEN NEW.memory_id IS NOT NULL
            AND (NEW.memory_id IS NOT OLD.memory_id OR NEW.tenant_id IS NOT OLD.tenant_id)
          BEGIN
            SELECT CASE
              WHEN NEW.tenant_id != (SELECT tenant_id FROM memories WHERE id = NEW.memory_id)
              THEN RAISE(ABORT, 'customer_notes.tenant_id must match memories.tenant_id for the referenced memory')
            END;
          END;

CREATE TRIGGER trg_decisions_supersede_tenant_match_update
          BEFORE UPDATE ON decisions
          WHEN NEW.superseded_by IS NOT NULL
            AND NEW.superseded_by IS NOT OLD.superseded_by
          BEGIN
            SELECT CASE
              WHEN NEW.tenant_id != (SELECT tenant_id FROM decisions WHERE id = NEW.superseded_by)
              THEN RAISE(ABORT, 'decisions.superseded_by must reference a decision in the same tenant')
            END;
          END;

CREATE TRIGGER trg_decisions_tenant_match_insert
          BEFORE INSERT ON decisions
          WHEN NEW.memory_id IS NOT NULL
          BEGIN
            SELECT CASE
              WHEN NEW.tenant_id != (SELECT tenant_id FROM memories WHERE id = NEW.memory_id)
              THEN RAISE(ABORT, 'decisions.tenant_id must match memories.tenant_id for the referenced memory')
            END;
          END;

CREATE TRIGGER trg_decisions_tenant_match_update
          BEFORE UPDATE ON decisions
          WHEN NEW.memory_id IS NOT NULL
            AND (NEW.memory_id IS NOT OLD.memory_id OR NEW.tenant_id IS NOT OLD.tenant_id)
          BEGIN
            SELECT CASE
              WHEN NEW.tenant_id != (SELECT tenant_id FROM memories WHERE id = NEW.memory_id)
              THEN RAISE(ABORT, 'decisions.tenant_id must match memories.tenant_id for the referenced memory')
            END;
          END;

CREATE TRIGGER trg_entities_consolidated_only_insert
        BEFORE INSERT ON entities
        BEGIN
          SELECT CASE
            WHEN (NEW.source_object_type IS NULL AND NEW.source_object_id IS NOT NULL)
              OR (NEW.source_object_type IS NOT NULL AND NEW.source_object_id IS NULL)
            THEN RAISE(ABORT, 'source_object_type and source_object_id must be set together (all-or-none)')
            WHEN NEW.memory_id IS NULL AND NEW.source_object_id IS NULL
            THEN RAISE(ABORT, 'graph row needs a memory or a source object')
            WHEN NEW.memory_id IS NOT NULL AND NEW.source_kind != (SELECT kind FROM memories WHERE id = NEW.memory_id)
            THEN RAISE(ABORT, 'entities.source_kind must equal the referenced memory kind; the graph indexes consolidated state only (no raw)')
            WHEN NEW.memory_id IS NOT NULL AND NEW.tenant_id != (SELECT tenant_id FROM memories WHERE id = NEW.memory_id)
            THEN RAISE(ABORT, 'entities.tenant_id must match memories.tenant_id for the referenced memory')
            WHEN NEW.source_object_type ='decision'
              AND NOT EXISTS (SELECT 1 FROM decisions WHERE id = NEW.source_object_id AND tenant_id = NEW.tenant_id AND status IN ('active', 'superseded'))
            THEN RAISE(ABORT, 'entities.source_object must reference an active/superseded decision in the same tenant')
            WHEN NEW.source_object_type ='policy'
              AND NOT EXISTS (SELECT 1 FROM policies WHERE id = NEW.source_object_id AND tenant_id = NEW.tenant_id AND status IN ('active', 'superseded'))
            THEN RAISE(ABORT, 'entities.source_object must reference an active/superseded policy in the same tenant')
            WHEN NEW.source_object_type ='customer'
              AND NOT EXISTS (SELECT 1 FROM customer_notes WHERE id = NEW.source_object_id AND tenant_id = NEW.tenant_id AND status IN ('active', 'superseded'))
            THEN RAISE(ABORT, 'entities.source_object must reference an active/superseded customer_note in the same tenant')
            WHEN NEW.source_object_type ='project'
              AND NOT EXISTS (SELECT 1 FROM project_briefs WHERE id = NEW.source_object_id AND tenant_id = NEW.tenant_id AND status IN ('active', 'superseded'))
            THEN RAISE(ABORT, 'entities.source_object must reference an active/superseded project_brief in the same tenant')
          END;
        END;

CREATE TRIGGER trg_entities_consolidated_only_update
        BEFORE UPDATE ON entities
        WHEN NEW.memory_id IS NOT OLD.memory_id
          OR NEW.source_kind IS NOT OLD.source_kind
          OR NEW.tenant_id IS NOT OLD.tenant_id
          OR NEW.source_object_type IS NOT OLD.source_object_type
          OR NEW.source_object_id IS NOT OLD.source_object_id
        BEGIN
          -- NO all-null ABORT on UPDATE: node:sqlite fires this BEFORE UPDATE trigger from
          -- the FK ON DELETE SET NULL action even with recursive_triggers OFF (empirically
          -- verified - the plan's "SET NULL does not fire the guard" premise is false for
          -- this build). A mirror forget on a memory-only entity legitimately produces an
          -- all-null row; aborting here would block the memory delete. The INSERT guard
          -- still forbids CREATING a provenance-less row, and the next graph rebuild clears
          -- any all-null orphan. A raw UPDATE to all-null is harmless (not recall-surfaced).
          -- Object-path STATUS is validated only when the object columns THEMSELVES change
          -- (an explicit re-point), NOT on the FK ON DELETE SET NULL transition (which changes
          -- only memory_id). This threads the needle (codex P1 + P2 round 4): the SET NULL of a
          -- since-closed object's mirror is NOT blocked (object cols unchanged -> object checks
          -- skip), while an explicit raw UPDATE that re-points the row to a bad/closed/cross-
          -- tenant object IS rejected. all-or-none + memory-path (raw/tenant) always apply.
          SELECT CASE
            WHEN (NEW.source_object_type IS NULL AND NEW.source_object_id IS NOT NULL)
              OR (NEW.source_object_type IS NOT NULL AND NEW.source_object_id IS NULL)
            THEN RAISE(ABORT, 'entities.source_object_type and source_object_id must be set together (all-or-none)')
            WHEN NEW.memory_id IS NOT NULL AND NEW.source_kind != (SELECT kind FROM memories WHERE id = NEW.memory_id)
            THEN RAISE(ABORT, 'entities.source_kind must equal the referenced memory kind; the graph indexes consolidated state only (no raw)')
            WHEN NEW.memory_id IS NOT NULL AND NEW.tenant_id != (SELECT tenant_id FROM memories WHERE id = NEW.memory_id)
            THEN RAISE(ABORT, 'entities.tenant_id must match memories.tenant_id for the referenced memory')
            WHEN (NEW.source_object_type IS NOT OLD.source_object_type OR NEW.source_object_id IS NOT OLD.source_object_id OR NEW.tenant_id IS NOT OLD.tenant_id)
              AND NEW.source_object_type ='decision'
              AND NOT EXISTS (SELECT 1 FROM decisions WHERE id = NEW.source_object_id AND tenant_id = NEW.tenant_id AND status IN ('active', 'superseded'))
            THEN RAISE(ABORT, 'entities.source_object must reference an active/superseded decision in the same tenant')
            WHEN (NEW.source_object_type IS NOT OLD.source_object_type OR NEW.source_object_id IS NOT OLD.source_object_id OR NEW.tenant_id IS NOT OLD.tenant_id)
              AND NEW.source_object_type ='policy'
              AND NOT EXISTS (SELECT 1 FROM policies WHERE id = NEW.source_object_id AND tenant_id = NEW.tenant_id AND status IN ('active', 'superseded'))
            THEN RAISE(ABORT, 'entities.source_object must reference an active/superseded policy in the same tenant')
            WHEN (NEW.source_object_type IS NOT OLD.source_object_type OR NEW.source_object_id IS NOT OLD.source_object_id OR NEW.tenant_id IS NOT OLD.tenant_id)
              AND NEW.source_object_type ='customer'
              AND NOT EXISTS (SELECT 1 FROM customer_notes WHERE id = NEW.source_object_id AND tenant_id = NEW.tenant_id AND status IN ('active', 'superseded'))
            THEN RAISE(ABORT, 'entities.source_object must reference an active/superseded customer_note in the same tenant')
            WHEN (NEW.source_object_type IS NOT OLD.source_object_type OR NEW.source_object_id IS NOT OLD.source_object_id OR NEW.tenant_id IS NOT OLD.tenant_id)
              AND NEW.source_object_type ='project'
              AND NOT EXISTS (SELECT 1 FROM project_briefs WHERE id = NEW.source_object_id AND tenant_id = NEW.tenant_id AND status IN ('active', 'superseded'))
            THEN RAISE(ABORT, 'entities.source_object must reference an active/superseded project_brief in the same tenant')
          END;
        END;

CREATE TRIGGER trg_entities_no_tenant_move_when_referenced
        BEFORE UPDATE ON entities
        WHEN NEW.tenant_id IS NOT OLD.tenant_id
          AND EXISTS (SELECT 1 FROM relations WHERE from_entity_id = OLD.id OR to_entity_id = OLD.id)
        BEGIN
          SELECT RAISE(ABORT, 'cannot move an entity cross-tenant while a relation references it as an endpoint (E3.3 graph-on-consolidated guard); rebuild/remove the relations first');
        END;

CREATE TRIGGER trg_graph_queue_consolidated_only_insert
          BEFORE INSERT ON graph_extraction_queue
          BEGIN
            SELECT CASE
              WHEN NEW.kind != (SELECT kind FROM memories WHERE id = NEW.memory_id)
              THEN RAISE(ABORT, 'graph_extraction_queue.kind must equal the referenced memory kind; only consolidated memories are queued (no raw)')
              WHEN NEW.tenant_id != (SELECT tenant_id FROM memories WHERE id = NEW.memory_id)
              THEN RAISE(ABORT, 'graph_extraction_queue.tenant_id must match memories.tenant_id for the referenced memory')
            END;
          END;

CREATE TRIGGER trg_graph_queue_consolidated_only_update
          BEFORE UPDATE ON graph_extraction_queue
          WHEN NEW.memory_id IS NOT OLD.memory_id
            OR NEW.kind IS NOT OLD.kind
            OR NEW.tenant_id IS NOT OLD.tenant_id
          BEGIN
            SELECT CASE
              WHEN NEW.kind != (SELECT kind FROM memories WHERE id = NEW.memory_id)
              THEN RAISE(ABORT, 'graph_extraction_queue.kind must equal the referenced memory kind; only consolidated memories are queued (no raw)')
              WHEN NEW.tenant_id != (SELECT tenant_id FROM memories WHERE id = NEW.memory_id)
              THEN RAISE(ABORT, 'graph_extraction_queue.tenant_id must match memories.tenant_id for the referenced memory')
            END;
          END;

CREATE TRIGGER trg_incidents_tenant_match_insert
          BEFORE INSERT ON incidents
          WHEN NEW.memory_id IS NOT NULL
          BEGIN
            SELECT CASE
              WHEN NEW.tenant_id != (SELECT tenant_id FROM memories WHERE id = NEW.memory_id)
              THEN RAISE(ABORT, 'incidents.tenant_id must match memories.tenant_id for the referenced memory')
            END;
          END;

CREATE TRIGGER trg_incidents_tenant_match_update
          BEFORE UPDATE ON incidents
          WHEN NEW.memory_id IS NOT NULL
            AND (NEW.memory_id IS NOT OLD.memory_id OR NEW.tenant_id IS NOT OLD.tenant_id)
          BEGIN
            SELECT CASE
              WHEN NEW.tenant_id != (SELECT tenant_id FROM memories WHERE id = NEW.memory_id)
              THEN RAISE(ABORT, 'incidents.tenant_id must match memories.tenant_id for the referenced memory')
            END;
          END;

CREATE TRIGGER trg_memories_graph_referenced_guard
          BEFORE UPDATE ON memories
          WHEN (NEW.kind IS NOT OLD.kind OR NEW.tenant_id IS NOT OLD.tenant_id)
            AND (
              EXISTS (SELECT 1 FROM entities WHERE memory_id = OLD.id)
              OR EXISTS (SELECT 1 FROM relations WHERE memory_id = OLD.id)
              OR EXISTS (SELECT 1 FROM graph_extraction_queue WHERE memory_id = OLD.id)
            )
          BEGIN
            SELECT RAISE(ABORT, 'cannot change the kind or tenant of a memory while the graph references it (E3.3 graph-on-consolidated guard); a graph-referenced memory is immutable in kind/tenant - rebuild/remove the graph rows first, or rebuild them after supersession');
          END;

CREATE TRIGGER trg_memories_kind_check_insert
        BEFORE INSERT ON memories
        WHEN NEW.kind IS NULL OR NEW.kind NOT IN ('raw','distilled','superseded','archived')
        BEGIN
          SELECT RAISE(ABORT, 'invalid kind: must be raw|distilled|superseded|archived (not null)');
        END;

CREATE TRIGGER trg_memories_kind_check_update
        BEFORE UPDATE ON memories
        WHEN NEW.kind IS NULL OR NEW.kind NOT IN ('raw','distilled','superseded','archived')
        BEGIN
          SELECT RAISE(ABORT, 'invalid kind: must be raw|distilled|superseded|archived (not null)');
        END;

CREATE TRIGGER trg_memories_raw_append_only
        BEFORE DELETE ON memories
        WHEN OLD.kind = 'raw'
        BEGIN
          SELECT RAISE(ABORT, 'raw is append-only');
        END;

CREATE TRIGGER trg_memory_vectors_delete AFTER DELETE ON memories BEGIN
    DELETE FROM memory_vectors WHERE memory_id = old.id;
  END;

CREATE TRIGGER trg_policies_supersede_tenant_match_update
          BEFORE UPDATE ON policies
          WHEN NEW.superseded_by IS NOT NULL
            AND NEW.superseded_by IS NOT OLD.superseded_by
          BEGIN
            SELECT CASE
              WHEN NEW.tenant_id != (SELECT tenant_id FROM policies WHERE id = NEW.superseded_by)
              THEN RAISE(ABORT, 'policies.superseded_by must reference a policy in the same tenant')
            END;
          END;

CREATE TRIGGER trg_policies_tenant_match_insert
          BEFORE INSERT ON policies
          WHEN NEW.memory_id IS NOT NULL
          BEGIN
            SELECT CASE
              WHEN NEW.tenant_id != (SELECT tenant_id FROM memories WHERE id = NEW.memory_id)
              THEN RAISE(ABORT, 'policies.tenant_id must match memories.tenant_id for the referenced memory')
            END;
          END;

CREATE TRIGGER trg_policies_tenant_match_update
          BEFORE UPDATE ON policies
          WHEN NEW.memory_id IS NOT NULL
            AND (NEW.memory_id IS NOT OLD.memory_id OR NEW.tenant_id IS NOT OLD.tenant_id)
          BEGIN
            SELECT CASE
              WHEN NEW.tenant_id != (SELECT tenant_id FROM memories WHERE id = NEW.memory_id)
              THEN RAISE(ABORT, 'policies.tenant_id must match memories.tenant_id for the referenced memory')
            END;
          END;

CREATE TRIGGER trg_predictions_tenant_match_insert
          BEFORE INSERT ON predictions
          WHEN NEW.memory_id IS NOT NULL
          BEGIN
            SELECT CASE
              WHEN NEW.tenant_id != (SELECT tenant_id FROM memories WHERE id = NEW.memory_id)
              THEN RAISE(ABORT, 'predictions.tenant_id must match memories.tenant_id for the referenced memory')
            END;
          END;

CREATE TRIGGER trg_predictions_tenant_match_update
          BEFORE UPDATE ON predictions
          WHEN NEW.memory_id IS NOT NULL
            AND (NEW.memory_id IS NOT OLD.memory_id OR NEW.tenant_id IS NOT OLD.tenant_id)
          BEGIN
            SELECT CASE
              WHEN NEW.tenant_id != (SELECT tenant_id FROM memories WHERE id = NEW.memory_id)
              THEN RAISE(ABORT, 'predictions.tenant_id must match memories.tenant_id for the referenced memory')
            END;
          END;

CREATE TRIGGER trg_processes_supersede_tenant_match_update
          BEFORE UPDATE ON processes
          WHEN NEW.superseded_by IS NOT NULL
            AND NEW.superseded_by IS NOT OLD.superseded_by
          BEGIN
            SELECT CASE
              WHEN NEW.tenant_id != (SELECT tenant_id FROM processes WHERE id = NEW.superseded_by)
              THEN RAISE(ABORT, 'processes.superseded_by must reference a process in the same tenant')
            END;
          END;

CREATE TRIGGER trg_processes_tenant_match_insert
          BEFORE INSERT ON processes
          WHEN NEW.memory_id IS NOT NULL
          BEGIN
            SELECT CASE
              WHEN NEW.tenant_id != (SELECT tenant_id FROM memories WHERE id = NEW.memory_id)
              THEN RAISE(ABORT, 'processes.tenant_id must match memories.tenant_id for the referenced memory')
            END;
          END;

CREATE TRIGGER trg_processes_tenant_match_update
          BEFORE UPDATE ON processes
          WHEN NEW.memory_id IS NOT NULL
            AND (NEW.memory_id IS NOT OLD.memory_id OR NEW.tenant_id IS NOT OLD.tenant_id)
          BEGIN
            SELECT CASE
              WHEN NEW.tenant_id != (SELECT tenant_id FROM memories WHERE id = NEW.memory_id)
              THEN RAISE(ABORT, 'processes.tenant_id must match memories.tenant_id for the referenced memory')
            END;
          END;

CREATE TRIGGER trg_project_briefs_supersede_tenant_match_update
          BEFORE UPDATE ON project_briefs
          WHEN NEW.superseded_by IS NOT NULL
            AND NEW.superseded_by IS NOT OLD.superseded_by
          BEGIN
            SELECT CASE
              WHEN NEW.tenant_id != (SELECT tenant_id FROM project_briefs WHERE id = NEW.superseded_by)
              THEN RAISE(ABORT, 'project_briefs.superseded_by must reference a project_brief in the same tenant')
            END;
          END;

CREATE TRIGGER trg_project_briefs_tenant_match_insert
          BEFORE INSERT ON project_briefs
          WHEN NEW.memory_id IS NOT NULL
          BEGIN
            SELECT CASE
              WHEN NEW.tenant_id != (SELECT tenant_id FROM memories WHERE id = NEW.memory_id)
              THEN RAISE(ABORT, 'project_briefs.tenant_id must match memories.tenant_id for the referenced memory')
            END;
          END;

CREATE TRIGGER trg_project_briefs_tenant_match_update
          BEFORE UPDATE ON project_briefs
          WHEN NEW.memory_id IS NOT NULL
            AND (NEW.memory_id IS NOT OLD.memory_id OR NEW.tenant_id IS NOT OLD.tenant_id)
          BEGIN
            SELECT CASE
              WHEN NEW.tenant_id != (SELECT tenant_id FROM memories WHERE id = NEW.memory_id)
              THEN RAISE(ABORT, 'project_briefs.tenant_id must match memories.tenant_id for the referenced memory')
            END;
          END;

CREATE TRIGGER trg_relations_consolidated_only_insert
        BEFORE INSERT ON relations
        BEGIN
          SELECT CASE
            WHEN (NEW.source_object_type IS NULL AND NEW.source_object_id IS NOT NULL)
              OR (NEW.source_object_type IS NOT NULL AND NEW.source_object_id IS NULL)
            THEN RAISE(ABORT, 'source_object_type and source_object_id must be set together (all-or-none)')
            WHEN NEW.memory_id IS NULL AND NEW.source_object_id IS NULL
            THEN RAISE(ABORT, 'graph row needs a memory or a source object')
            WHEN NEW.memory_id IS NOT NULL AND NEW.source_kind != (SELECT kind FROM memories WHERE id = NEW.memory_id)
            THEN RAISE(ABORT, 'relations.source_kind must equal the referenced memory kind; the graph indexes consolidated state only (no raw)')
            WHEN NEW.memory_id IS NOT NULL AND NEW.tenant_id != (SELECT tenant_id FROM memories WHERE id = NEW.memory_id)
            THEN RAISE(ABORT, 'relations.tenant_id must match memories.tenant_id for the referenced memory')
            WHEN NEW.source_object_type ='decision'
              AND NOT EXISTS (SELECT 1 FROM decisions WHERE id = NEW.source_object_id AND tenant_id = NEW.tenant_id AND status IN ('active', 'superseded'))
            THEN RAISE(ABORT, 'relations.source_object must reference an active/superseded decision in the same tenant')
            WHEN NEW.source_object_type ='policy'
              AND NOT EXISTS (SELECT 1 FROM policies WHERE id = NEW.source_object_id AND tenant_id = NEW.tenant_id AND status IN ('active', 'superseded'))
            THEN RAISE(ABORT, 'relations.source_object must reference an active/superseded policy in the same tenant')
            WHEN NEW.source_object_type ='customer'
              AND NOT EXISTS (SELECT 1 FROM customer_notes WHERE id = NEW.source_object_id AND tenant_id = NEW.tenant_id AND status IN ('active', 'superseded'))
            THEN RAISE(ABORT, 'relations.source_object must reference an active/superseded customer_note in the same tenant')
            WHEN NEW.source_object_type ='project'
              AND NOT EXISTS (SELECT 1 FROM project_briefs WHERE id = NEW.source_object_id AND tenant_id = NEW.tenant_id AND status IN ('active', 'superseded'))
            THEN RAISE(ABORT, 'relations.source_object must reference an active/superseded project_brief in the same tenant')
            WHEN NEW.tenant_id != (SELECT tenant_id FROM entities WHERE id = NEW.from_entity_id)
            THEN RAISE(ABORT, 'relations.tenant_id must match the from_entity tenant (no cross-tenant edges)')
            WHEN NEW.tenant_id != (SELECT tenant_id FROM entities WHERE id = NEW.to_entity_id)
            THEN RAISE(ABORT, 'relations.tenant_id must match the to_entity tenant (no cross-tenant edges)')
          END;
        END;

CREATE TRIGGER trg_relations_consolidated_only_update
        BEFORE UPDATE ON relations
        WHEN NEW.memory_id IS NOT OLD.memory_id
          OR NEW.source_kind IS NOT OLD.source_kind
          OR NEW.tenant_id IS NOT OLD.tenant_id
          OR NEW.source_object_type IS NOT OLD.source_object_type
          OR NEW.source_object_id IS NOT OLD.source_object_id
          OR NEW.from_entity_id IS NOT OLD.from_entity_id
          OR NEW.to_entity_id IS NOT OLD.to_entity_id
        BEGIN
          -- NO all-null ABORT on UPDATE (same reason as the entities UPDATE trigger): the FK
          -- ON DELETE SET NULL fires this trigger in node:sqlite, and a mirror forget on a
          -- memory-only relation legitimately nulls memory_id. The INSERT guard still forbids
          -- creating a provenance-less relation; the rebuild clears any orphan.
          -- Object-path STATUS validated only on an explicit object-column change, NOT on the
          -- FK SET NULL transition (see the entities UPDATE trigger): SET NULL of a since-closed
          -- object's mirror is not blocked (object cols unchanged), while an explicit re-point to
          -- a bad object is rejected. all-or-none + memory-path + endpoint checks always apply.
          SELECT CASE
            WHEN (NEW.source_object_type IS NULL AND NEW.source_object_id IS NOT NULL)
              OR (NEW.source_object_type IS NOT NULL AND NEW.source_object_id IS NULL)
            THEN RAISE(ABORT, 'relations.source_object_type and source_object_id must be set together (all-or-none)')
            WHEN NEW.memory_id IS NOT NULL AND NEW.source_kind != (SELECT kind FROM memories WHERE id = NEW.memory_id)
            THEN RAISE(ABORT, 'relations.source_kind must equal the referenced memory kind; the graph indexes consolidated state only (no raw)')
            WHEN NEW.memory_id IS NOT NULL AND NEW.tenant_id != (SELECT tenant_id FROM memories WHERE id = NEW.memory_id)
            THEN RAISE(ABORT, 'relations.tenant_id must match memories.tenant_id for the referenced memory')
            WHEN (NEW.source_object_type IS NOT OLD.source_object_type OR NEW.source_object_id IS NOT OLD.source_object_id OR NEW.tenant_id IS NOT OLD.tenant_id)
              AND NEW.source_object_type ='decision'
              AND NOT EXISTS (SELECT 1 FROM decisions WHERE id = NEW.source_object_id AND tenant_id = NEW.tenant_id AND status IN ('active', 'superseded'))
            THEN RAISE(ABORT, 'relations.source_object must reference an active/superseded decision in the same tenant')
            WHEN (NEW.source_object_type IS NOT OLD.source_object_type OR NEW.source_object_id IS NOT OLD.source_object_id OR NEW.tenant_id IS NOT OLD.tenant_id)
              AND NEW.source_object_type ='policy'
              AND NOT EXISTS (SELECT 1 FROM policies WHERE id = NEW.source_object_id AND tenant_id = NEW.tenant_id AND status IN ('active', 'superseded'))
            THEN RAISE(ABORT, 'relations.source_object must reference an active/superseded policy in the same tenant')
            WHEN (NEW.source_object_type IS NOT OLD.source_object_type OR NEW.source_object_id IS NOT OLD.source_object_id OR NEW.tenant_id IS NOT OLD.tenant_id)
              AND NEW.source_object_type ='customer'
              AND NOT EXISTS (SELECT 1 FROM customer_notes WHERE id = NEW.source_object_id AND tenant_id = NEW.tenant_id AND status IN ('active', 'superseded'))
            THEN RAISE(ABORT, 'relations.source_object must reference an active/superseded customer_note in the same tenant')
            WHEN (NEW.source_object_type IS NOT OLD.source_object_type OR NEW.source_object_id IS NOT OLD.source_object_id OR NEW.tenant_id IS NOT OLD.tenant_id)
              AND NEW.source_object_type ='project'
              AND NOT EXISTS (SELECT 1 FROM project_briefs WHERE id = NEW.source_object_id AND tenant_id = NEW.tenant_id AND status IN ('active', 'superseded'))
            THEN RAISE(ABORT, 'relations.source_object must reference an active/superseded project_brief in the same tenant')
            WHEN NEW.tenant_id != (SELECT tenant_id FROM entities WHERE id = NEW.from_entity_id)
            THEN RAISE(ABORT, 'relations.tenant_id must match the from_entity tenant (no cross-tenant edges)')
            WHEN NEW.tenant_id != (SELECT tenant_id FROM entities WHERE id = NEW.to_entity_id)
            THEN RAISE(ABORT, 'relations.tenant_id must match the to_entity tenant (no cross-tenant edges)')
          END;
        END;

CREATE TRIGGER trg_skills_supersede_tenant_match_update
          BEFORE UPDATE ON skills
          WHEN NEW.superseded_by IS NOT NULL
            AND NEW.superseded_by IS NOT OLD.superseded_by
          BEGIN
            SELECT CASE
              WHEN NEW.tenant_id != (SELECT tenant_id FROM skills WHERE id = NEW.superseded_by)
              THEN RAISE(ABORT, 'skills.superseded_by must reference a skill in the same tenant')
            END;
          END;

CREATE TRIGGER trg_skills_tenant_match_insert
          BEFORE INSERT ON skills
          WHEN NEW.memory_id IS NOT NULL
          BEGIN
            SELECT CASE
              WHEN NEW.tenant_id != (SELECT tenant_id FROM memories WHERE id = NEW.memory_id)
              THEN RAISE(ABORT, 'skills.tenant_id must match memories.tenant_id for the referenced memory')
            END;
          END;

CREATE TRIGGER trg_skills_tenant_match_update
          BEFORE UPDATE ON skills
          WHEN NEW.memory_id IS NOT NULL
            AND (NEW.memory_id IS NOT OLD.memory_id OR NEW.tenant_id IS NOT OLD.tenant_id)
          BEGIN
            SELECT CASE
              WHEN NEW.tenant_id != (SELECT tenant_id FROM memories WHERE id = NEW.memory_id)
              THEN RAISE(ABORT, 'skills.tenant_id must match memories.tenant_id for the referenced memory')
            END;
          END;

INSERT INTO meta (key, value) VALUES ('default_half_life_base', '365');
INSERT INTO meta (key, value) VALUES ('fts5_available', '1');
INSERT INTO meta (key, value) VALUES ('last_retrieval_ids', '[]');
INSERT INTO meta (key, value) VALUES ('last_trace_id', '');
INSERT INTO meta (key, value) VALUES ('min_compatible_binary', '1.24.0');
INSERT INTO meta (key, value) VALUES ('total_forgotten', '0');
INSERT INTO meta (key, value) VALUES ('total_recalled', '0');
INSERT INTO meta (key, value) VALUES ('total_remembered', '0');
INSERT INTO meta (key, value) VALUES ('typed_half_life_on_default', '1');
INSERT INTO meta (key, value) VALUES ('schema_version', '56');
PRAGMA user_version = 56;
