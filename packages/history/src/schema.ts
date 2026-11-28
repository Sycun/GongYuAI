/**
 * SQLite DDL & additive schema migrations for `HistoryStore`.
 * Extracted from `index.ts` to keep core Fact–Intent–Goal DAG logic clean.
 */
import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

export function eventHash(
  prev: string | null,
  event: { id: string; taskId: string; kind: string; payloadJson: string; createdAt: string },
): string {
  return createHash("sha256")
    .update(
      [prev ?? "", event.id, event.taskId, event.kind, event.payloadJson, event.createdAt].join("\n"),
    )
    .digest("hex");
}

export function migrateHistorySchema(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS facts (
      id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL,
      layer TEXT NOT NULL,
      title TEXT NOT NULL,
      summary TEXT NOT NULL DEFAULT '',
      evidence_path TEXT,
      tags_json TEXT NOT NULL DEFAULT '[]',
      created_at TEXT NOT NULL,
      intent_id TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_facts_task ON facts(task_id, created_at);

    CREATE TABLE IF NOT EXISTS intents (
      id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL,
      title TEXT NOT NULL,
      summary TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL,
      source_fact_ids_json TEXT NOT NULL DEFAULT '["origin"]',
      claimed_by TEXT,
      technique TEXT,
      asset_root TEXT,
      requeue_count INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      concluded_at TEXT,
      conclusion TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_intents_task ON intents(task_id, status);

    CREATE TABLE IF NOT EXISTS goals (
      id TEXT NOT NULL,
      task_id TEXT NOT NULL,
      title TEXT NOT NULL,
      description TEXT NOT NULL,
      evidence_patterns_json TEXT NOT NULL,
      passes INTEGER NOT NULL DEFAULT 0,
      evidence_paths_json TEXT NOT NULL DEFAULT '[]',
      asserted_at TEXT,
      PRIMARY KEY (task_id, id)
    );

    CREATE TABLE IF NOT EXISTS goal_checks (
      task_id TEXT NOT NULL, goal_id TEXT NOT NULL, checks_json TEXT NOT NULL,
      PRIMARY KEY(task_id, goal_id)
    );
    CREATE TABLE IF NOT EXISTS evidence_versions (
      sha256 TEXT PRIMARY KEY, content BLOB NOT NULL
    );
    CREATE TABLE IF NOT EXISTS goal_proofs (
      task_id TEXT NOT NULL, goal_id TEXT NOT NULL, path TEXT NOT NULL,
      sha256 TEXT NOT NULL REFERENCES evidence_versions(sha256),
      PRIMARY KEY(task_id, goal_id, path)
    );

    CREATE TABLE IF NOT EXISTS reconcile_revisions (
      task_id TEXT NOT NULL,
      id TEXT NOT NULL,
      revision_json TEXT NOT NULL,
      goal_ids_json TEXT NOT NULL DEFAULT '[]',
      config_digest TEXT NOT NULL,
      evidence_path TEXT NOT NULL,
      evidence_sha256 TEXT NOT NULL,
      counts_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY (task_id, id)
    );
    CREATE INDEX IF NOT EXISTS idx_reconcile_revisions_task ON reconcile_revisions(task_id, id);

    CREATE TABLE IF NOT EXISTS coverage_reviews (
      id TEXT PRIMARY KEY, task_id TEXT NOT NULL, goal_id TEXT NOT NULL,
      status TEXT NOT NULL, reviewer TEXT NOT NULL, reason TEXT NOT NULL,
      path TEXT, sha256 TEXT REFERENCES evidence_versions(sha256), created_at TEXT NOT NULL,
      FOREIGN KEY(task_id, goal_id) REFERENCES goals(task_id, id)
    );
    CREATE INDEX IF NOT EXISTS idx_coverage_task ON coverage_reviews(task_id, goal_id);

    CREATE TABLE IF NOT EXISTS fact_reviews (
      id TEXT PRIMARY KEY, task_id TEXT NOT NULL, fact_id TEXT NOT NULL REFERENCES facts(id),
      goal_id TEXT NOT NULL, decision TEXT NOT NULL, replacement_fact_id TEXT REFERENCES facts(id),
      reviewer TEXT NOT NULL, reason TEXT NOT NULL, path TEXT NOT NULL,
      sha256 TEXT NOT NULL REFERENCES evidence_versions(sha256), created_at TEXT NOT NULL,
      FOREIGN KEY(task_id, goal_id) REFERENCES goals(task_id, id)
    );
    CREATE INDEX IF NOT EXISTS idx_reviews_task ON fact_reviews(task_id, goal_id);

    CREATE TABLE IF NOT EXISTS events (
      id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      payload_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL,
      prev_hash TEXT,
      hash TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_events_task ON events(task_id, created_at);

    CREATE TABLE IF NOT EXISTS command_attempts (
      task_id TEXT NOT NULL,
      command_hash TEXT NOT NULL,
      count INTEGER NOT NULL DEFAULT 0,
      first_at TEXT NOT NULL,
      last_at TEXT NOT NULL,
      PRIMARY KEY(task_id, command_hash)
    );

    CREATE TABLE IF NOT EXISTS hints (
      id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL,
      text TEXT NOT NULL,
      source TEXT NOT NULL DEFAULT 'human',
      tags_json TEXT NOT NULL DEFAULT '[]',
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_hints_task ON hints(task_id, created_at);

    CREATE TABLE IF NOT EXISTS worker_advisories (
      id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      priority TEXT NOT NULL,
      target_intent_id TEXT,
      target_worker_slot INTEGER,
      asset_scope TEXT,
      summary TEXT NOT NULL,
      created_by TEXT NOT NULL,
      created_at TEXT NOT NULL,
      consumed_at TEXT,
      consumed_by_slot INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_worker_advisories_task ON worker_advisories(task_id, consumed_at);

    CREATE TABLE IF NOT EXISTS tactical_lessons (
      id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL,
      intent_id TEXT,
      asset_root TEXT NOT NULL,
      family_key TEXT NOT NULL DEFAULT '',
      tech_tags_json TEXT NOT NULL DEFAULT '[]',
      falsified_hypotheses_json TEXT NOT NULL DEFAULT '[]',
      antipatterns_json TEXT NOT NULL DEFAULT '[]',
      effective_pattern TEXT,
      next_pivot_advice TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_tactical_lessons_asset ON tactical_lessons(task_id, asset_root);
    CREATE INDEX IF NOT EXISTS idx_tactical_lessons_family ON tactical_lessons(task_id, family_key);

    CREATE TABLE IF NOT EXISTS host_profiles (
      id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL,
      asset TEXT NOT NULL,
      hostname TEXT,
      os TEXT,
      domain TEXT,
      users_json TEXT NOT NULL DEFAULT '[]',
      privileges_json TEXT NOT NULL DEFAULT '[]',
      services_json TEXT NOT NULL DEFAULT '[]',
      shares_json TEXT NOT NULL DEFAULT '[]',
      av_json TEXT NOT NULL DEFAULT '[]',
      evidence_path TEXT,
      source TEXT NOT NULL DEFAULT 'worker',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_host_profiles_unique ON host_profiles(task_id, asset);

    CREATE TABLE IF NOT EXISTS finding_retests (
      id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL,
      finding_id TEXT NOT NULL,
      verdict TEXT NOT NULL,
      evidence_json TEXT NOT NULL DEFAULT '[]',
      repro TEXT NOT NULL DEFAULT '',
      note TEXT NOT NULL DEFAULT '',
      reviewer TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_retests_finding ON finding_retests(task_id, finding_id, created_at);

    CREATE TABLE IF NOT EXISTS finding_validations (
      id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL,
      finding_id TEXT NOT NULL,
      verdict TEXT NOT NULL,
      method TEXT NOT NULL,
      evidence_json TEXT NOT NULL DEFAULT '[]',
      note TEXT NOT NULL DEFAULT '',
      validator TEXT NOT NULL,
      independent INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_validations_finding
      ON finding_validations(task_id, finding_id, created_at);

    CREATE TABLE IF NOT EXISTS plan_steps (
      id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL,
      ord INTEGER NOT NULL,
      title TEXT NOT NULL,
      summary TEXT NOT NULL DEFAULT '',
      needs_fact_ids_json TEXT NOT NULL DEFAULT '[]',
      needs_intent_ids_json TEXT NOT NULL DEFAULT '[]',
      needs_finding_ids_json TEXT NOT NULL DEFAULT '[]',
      status TEXT NOT NULL DEFAULT 'pending',
      intent_id TEXT,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_plan_task ON plan_steps(task_id, ord);

    CREATE TABLE IF NOT EXISTS oast_tokens (
      token TEXT PRIMARY KEY,
      task_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      callback TEXT NOT NULL,
      note TEXT NOT NULL DEFAULT '',
      issued_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      hits INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS oast_hits (
      id TEXT PRIMARY KEY,
      token TEXT NOT NULL,
      task_id TEXT NOT NULL,
      at TEXT NOT NULL,
      source_ip TEXT NOT NULL DEFAULT '',
      method TEXT NOT NULL DEFAULT '',
      path TEXT NOT NULL DEFAULT '',
      user_agent TEXT NOT NULL DEFAULT '',
      protocol TEXT NOT NULL DEFAULT 'http'
    );
    CREATE INDEX IF NOT EXISTS idx_oast_hits_task ON oast_hits(task_id, at);

    CREATE TABLE IF NOT EXISTS http_transactions (
      id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL,
      intent_id TEXT,
      method TEXT NOT NULL,
      url TEXT NOT NULL,
      host TEXT NOT NULL,
      path TEXT NOT NULL,
      status INTEGER NOT NULL,
      request_sha256 TEXT NOT NULL,
      response_sha256 TEXT NOT NULL,
      request_path TEXT NOT NULL,
      response_path TEXT NOT NULL,
      request_bytes INTEGER NOT NULL,
      response_bytes INTEGER NOT NULL,
      response_head TEXT NOT NULL DEFAULT '',
      truncated INTEGER NOT NULL DEFAULT 0,
      redirects_json TEXT NOT NULL DEFAULT '[]',
      started_at TEXT NOT NULL,
      duration_ms INTEGER NOT NULL,
      note TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_http_tx_task ON http_transactions(task_id, created_at);

    CREATE TABLE IF NOT EXISTS credentials (
      id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      asset TEXT NOT NULL,
      username TEXT,
      secret_ref TEXT NOT NULL,
      secret_hmac TEXT,
      source_finding_id TEXT,
      fact_id TEXT,
      verified_at TEXT,
      last_used_at TEXT,
      reuse_count INTEGER NOT NULL DEFAULT 0,
      expires_at TEXT,
      created_at TEXT NOT NULL,
      tier TEXT,
      impact_summary TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_credentials_task ON credentials(task_id, asset);

    CREATE TABLE IF NOT EXISTS credential_checks (
      id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL,
      credential_id TEXT NOT NULL,
      target_asset TEXT NOT NULL,
      service TEXT NOT NULL,
      verdict TEXT NOT NULL,
      evidence_path TEXT,
      note TEXT NOT NULL DEFAULT '',
      checked_by TEXT NOT NULL,
      checked_at TEXT NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_credential_checks_unique
      ON credential_checks(task_id, credential_id, target_asset, service);

    CREATE TABLE IF NOT EXISTS leases (
      task_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      owner TEXT NOT NULL,
      until_iso TEXT NOT NULL,
      PRIMARY KEY (task_id, kind)
    );

    CREATE TABLE IF NOT EXISTS findings (
      id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL,
      title TEXT NOT NULL,
      asset TEXT NOT NULL,
      vuln_class TEXT NOT NULL,
      severity TEXT NOT NULL,
      cvss TEXT,
      confidence TEXT NOT NULL,
      status TEXT NOT NULL,
      endpoint TEXT,
      dedup_key TEXT NOT NULL,
      intent_id TEXT,
      fact_ids_json TEXT NOT NULL DEFAULT '[]',
      evidence_json TEXT NOT NULL DEFAULT '[]',
      repro TEXT NOT NULL DEFAULT '',
      impact TEXT NOT NULL DEFAULT '',
      fix TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL,
      verified_at TEXT,
      verified_by TEXT,
      qualification TEXT,
      traffic_ids_json TEXT,
      summary TEXT,
      affected_scope TEXT,
      root_cause TEXT,
      poc_curl TEXT,
      report_md TEXT,
      UNIQUE(task_id, dedup_key)
    );
    CREATE INDEX IF NOT EXISTS idx_findings_task ON findings(task_id, status);

    CREATE TABLE IF NOT EXISTS finding_proofs (
      task_id TEXT NOT NULL, finding_id TEXT NOT NULL, path TEXT NOT NULL,
      sha256 TEXT NOT NULL REFERENCES evidence_versions(sha256),
      PRIMARY KEY(task_id, finding_id, path)
    );

    CREATE TABLE IF NOT EXISTS goal_findings (
      task_id TEXT NOT NULL,
      goal_id TEXT NOT NULL,
      finding_id TEXT NOT NULL,
      status_at_assert TEXT NOT NULL,
      evidence_json TEXT NOT NULL DEFAULT '[]',
      created_at TEXT NOT NULL,
      PRIMARY KEY (task_id, goal_id, finding_id)
    );
    CREATE INDEX IF NOT EXISTS idx_goal_findings_task ON goal_findings(task_id, goal_id);

    CREATE TABLE IF NOT EXISTS finding_actions (
      id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL,
      finding_id TEXT NOT NULL,
      action TEXT NOT NULL,
      result TEXT NOT NULL,
      note TEXT NOT NULL DEFAULT '',
      path TEXT NOT NULL,
      sha256 TEXT NOT NULL REFERENCES evidence_versions(sha256),
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_finding_actions_task ON finding_actions(task_id, finding_id);

    CREATE TABLE IF NOT EXISTS delivery_corrections (
      id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL,
      number INTEGER NOT NULL,
      reason TEXT NOT NULL,
      findings_json TEXT NOT NULL,
      goals_json TEXT NOT NULL,
      report_json TEXT NOT NULL DEFAULT '[]',
      notice_status TEXT NOT NULL DEFAULT 'pending',
      evidence_path TEXT,
      sha256 TEXT,
      dedup_key TEXT NOT NULL,
      created_at TEXT NOT NULL,
      UNIQUE(task_id, number),
      UNIQUE(task_id, dedup_key)
    );

    CREATE TABLE IF NOT EXISTS retest_requests (
      id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL,
      requester TEXT NOT NULL,
      role TEXT,
      finding_ids_json TEXT NOT NULL,
      reason TEXT NOT NULL,
      path TEXT,
      sha256 TEXT REFERENCES evidence_versions(sha256),
      status TEXT NOT NULL DEFAULT 'pending',
      fulfilled_at TEXT,
      fulfilled_result TEXT,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_retest_requests_task ON retest_requests(task_id, created_at);

    CREATE TABLE IF NOT EXISTS peer_reviews (
      id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL,
      engagement_id TEXT NOT NULL,
      reviewer TEXT NOT NULL,
      role TEXT NOT NULL,
      source_task_id TEXT NOT NULL,
      finding_id TEXT,
      fact_id TEXT,
      decision TEXT NOT NULL,
      basis TEXT NOT NULL,
      path TEXT,
      sha256 TEXT REFERENCES evidence_versions(sha256),
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_peer_reviews_task ON peer_reviews(task_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_peer_reviews_engagement ON peer_reviews(engagement_id, created_at);

    CREATE TABLE IF NOT EXISTS material_citations (
      id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL,
      engagement_id TEXT NOT NULL,
      material_id TEXT NOT NULL,
      version_id TEXT NOT NULL,
      locator TEXT NOT NULL,
      claim TEXT NOT NULL,
      body_format TEXT NOT NULL,
      material_title TEXT NOT NULL,
      publisher TEXT NOT NULL,
      source_kind TEXT NOT NULL,
      version_no INTEGER NOT NULL,
      version_label TEXT NOT NULL,
      section_heading TEXT,
      section_page INTEGER,
      section_ordinal INTEGER NOT NULL,
      sha256 TEXT NOT NULL REFERENCES evidence_versions(sha256),
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_material_citations_task ON material_citations(task_id, created_at);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_material_citations_dedup
      ON material_citations(task_id, material_id, version_id, locator, claim);
  `);

  ensureIntentSourceFactIdsColumn(db);
  ensureIntentTechniqueColumns(db);
  ensureIntentSurfacePartitionColumns(db);
  ensureGoalColumns(db);
  ensureCitationPinColumns(db);
  migrateColumns(db);
}

function ensureCitationPinColumns(db: DatabaseSync): void {
  const cols = db.prepare(`PRAGMA table_info(material_citations)`).all() as Array<{ name: string }>;
  const have = new Set(cols.map((c) => c.name));
  const add: Record<string, string> = {
    pin_kind: "TEXT NOT NULL DEFAULT 'locator'",
    char_start: "INTEGER",
    char_end: "INTEGER",
    chunk_sha256: "TEXT",
    section_json: "TEXT",
  };
  for (const [name, definition] of Object.entries(add)) {
    if (!have.has(name)) db.exec(`ALTER TABLE material_citations ADD COLUMN ${name} ${definition}`);
  }
}

function ensureGoalColumns(db: DatabaseSync): void {
  const cols = db.prepare(`PRAGMA table_info(goals)`).all() as Array<{ name: string }>;
  const have = new Set(cols.map((c) => c.name));
  if (!have.has("findings_gate_json")) db.exec(`ALTER TABLE goals ADD COLUMN findings_gate_json TEXT`);
  if (!have.has("assets_json")) db.exec(`ALTER TABLE goals ADD COLUMN assets_json TEXT`);
  if (!have.has("board_gate")) db.exec(`ALTER TABLE goals ADD COLUMN board_gate TEXT`);
  if (!have.has("reconcile_gate_json")) db.exec(`ALTER TABLE goals ADD COLUMN reconcile_gate_json TEXT`);
  if (!have.has("goal_kind")) db.exec(`ALTER TABLE goals ADD COLUMN goal_kind TEXT`);
  if (!have.has("business_json")) db.exec(`ALTER TABLE goals ADD COLUMN business_json TEXT`);
}

function ensureIntentTechniqueColumns(db: DatabaseSync): void {
  const cols = db.prepare(`PRAGMA table_info(intents)`).all() as Array<{ name: string }>;
  const have = new Set(cols.map((column) => column.name));
  if (!have.has("technique")) db.exec(`ALTER TABLE intents ADD COLUMN technique TEXT`);
  if (!have.has("asset_root")) db.exec(`ALTER TABLE intents ADD COLUMN asset_root TEXT`);
  if (!have.has("requeue_count")) {
    db.exec(`ALTER TABLE intents ADD COLUMN requeue_count INTEGER NOT NULL DEFAULT 0`);
  }
}

function ensureIntentSourceFactIdsColumn(db: DatabaseSync): void {
  const cols = db.prepare(`PRAGMA table_info(intents)`).all() as Array<{ name: string }>;
  if (cols.some((c) => c.name === "source_fact_ids_json")) return;
  db.exec(`ALTER TABLE intents ADD COLUMN source_fact_ids_json TEXT NOT NULL DEFAULT '["origin"]'`);
}

/** Sub-surface mutex partition: additive columns for legacy intent rows. */
function ensureIntentSurfacePartitionColumns(db: DatabaseSync): void {
  const cols = db.prepare(`PRAGMA table_info(intents)`).all() as Array<{ name: string }>;
  const have = new Set(cols.map((column) => column.name));
  if (!have.has("assigned_surfaces_json")) {
    db.exec(`ALTER TABLE intents ADD COLUMN assigned_surfaces_json TEXT NOT NULL DEFAULT '[]'`);
  }
  if (!have.has("mutex_note")) {
    db.exec(`ALTER TABLE intents ADD COLUMN mutex_note TEXT NOT NULL DEFAULT ''`);
  }
}

function migrateColumns(db: DatabaseSync): void {
  const columns = new Set(
    (db.prepare("PRAGMA table_info(credentials)").all() as Array<Record<string, unknown>>)
      .map((row) => String(row.name)),
  );
  if (!columns.has("fact_id")) {
    db.exec("ALTER TABLE credentials ADD COLUMN fact_id TEXT");
  }
  if (!columns.has("tier")) {
    db.exec("ALTER TABLE credentials ADD COLUMN tier TEXT");
    db.exec(`
      UPDATE credentials
      SET tier = CASE
        WHEN verified_at IS NOT NULL AND length(trim(verified_at)) > 0 THEN 'L2'
        ELSE 'L1'
      END
      WHERE tier IS NULL OR length(trim(tier)) = 0
    `);
  }
  if (!columns.has("impact_summary")) {
    db.exec("ALTER TABLE credentials ADD COLUMN impact_summary TEXT");
  }
  const findingCols = new Set(
    (db.prepare("PRAGMA table_info(findings)").all() as Array<Record<string, unknown>>)
      .map((row) => String(row.name)),
  );
  if (!findingCols.has("verified_by")) db.exec("ALTER TABLE findings ADD COLUMN verified_by TEXT");
  if (!findingCols.has("qualification")) db.exec("ALTER TABLE findings ADD COLUMN qualification TEXT");
  if (!findingCols.has("traffic_ids_json")) db.exec("ALTER TABLE findings ADD COLUMN traffic_ids_json TEXT");
  if (!findingCols.has("summary")) db.exec("ALTER TABLE findings ADD COLUMN summary TEXT");
  if (!findingCols.has("affected_scope")) db.exec("ALTER TABLE findings ADD COLUMN affected_scope TEXT");
  if (!findingCols.has("root_cause")) db.exec("ALTER TABLE findings ADD COLUMN root_cause TEXT");
  if (!findingCols.has("poc_curl")) db.exec("ALTER TABLE findings ADD COLUMN poc_curl TEXT");
  if (!findingCols.has("report_md")) db.exec("ALTER TABLE findings ADD COLUMN report_md TEXT");
  ensureEventHashChain(db);
}

function ensureEventHashChain(db: DatabaseSync): void {
  const cols = new Set(
    (db.prepare("PRAGMA table_info(events)").all() as Array<Record<string, unknown>>)
      .map((row) => String(row.name)),
  );
  if (!cols.has("prev_hash")) db.exec("ALTER TABLE events ADD COLUMN prev_hash TEXT");
  if (!cols.has("hash")) db.exec("ALTER TABLE events ADD COLUMN hash TEXT");
  const legacy = db
    .prepare("SELECT DISTINCT task_id FROM events WHERE hash IS NULL")
    .all() as Array<{ task_id: string }>;
  for (const row of legacy) {
    const taskId = String(row.task_id);
    const events = db
      .prepare(
        "SELECT id, task_id, kind, payload_json, created_at FROM events WHERE task_id = ? ORDER BY rowid",
      )
      .all(taskId) as Array<Record<string, unknown>>;
    let prev: string | null = null;
    const update = db.prepare("UPDATE events SET prev_hash = ?, hash = ? WHERE id = ?");
    db.exec("BEGIN");
    try {
      for (const event of events) {
        const hash = eventHash(prev, {
          id: String(event.id),
          taskId,
          kind: String(event.kind),
          payloadJson: String(event.payload_json),
          createdAt: String(event.created_at),
        });
        update.run(prev, hash, String(event.id));
        prev = hash;
      }
      db.exec("COMMIT");
    } catch (err) {
      db.exec("ROLLBACK");
      throw err;
    }
  }
}
