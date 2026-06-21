import fs from "node:fs";
import path from "node:path";
import Database, { type Database as DB, type Statement } from "better-sqlite3";
import { baselineRuleDefinitions } from "./baselineRules";
import { seedInitialKnowledgeBase } from "./knowledgeBase";

export type SqlParam = string | number | null | Uint8Array;
export type SqlParams = SqlParam[];

// better-sqlite3 binds blobs as Buffer; convert any Uint8Array params.
function bindable(params: SqlParams): unknown[] {
  return params.map((p) => (p instanceof Uint8Array ? Buffer.from(p) : p));
}

// File-backed SQLite via better-sqlite3. Writes incrementally to disk under WAL
// — no full-file rewrite per write — so it scales to large data and concurrent
// reads. The query/get/run/exec/transaction interface is unchanged, so all
// call sites are untouched.
export class AppDb {
  private transactionDepth = 0;
  private readonly stmtCache = new Map<string, Statement>();

  constructor(private readonly db: DB) {}

  private prepare(sql: string): Statement {
    let stmt = this.stmtCache.get(sql);
    if (!stmt) {
      stmt = this.db.prepare(sql);
      this.stmtCache.set(sql, stmt);
    }
    return stmt;
  }

  query<T = Record<string, unknown>>(sql: string, params: SqlParams = []): T[] {
    return this.prepare(sql).all(...bindable(params)) as T[];
  }

  get<T = Record<string, unknown>>(sql: string, params: SqlParams = []): T | null {
    return (this.prepare(sql).get(...bindable(params)) as T | undefined) ?? null;
  }

  run(sql: string, params: SqlParams = []): void {
    this.prepare(sql).run(...bindable(params));
  }

  // Multi-statement DDL/seed scripts. Not parameterized.
  exec(sql: string): void {
    this.db.exec(sql);
  }

  // Online snapshot backup. VACUUM INTO writes a clean, compacted copy of the
  // whole database (committed WAL contents included) to a new file while the
  // app keeps running. The destination must not already exist.
  backupTo(filePath: string): void {
    this.db.exec(`VACUUM INTO '${filePath.replace(/'/g, "''")}'`);
  }

  transaction<T>(fn: () => T): T {
    // Reentrancy guard: SQLite cannot nest BEGIN. If a transaction is already
    // open, run the work inline and let the outermost call commit.
    if (this.transactionDepth > 0) {
      this.transactionDepth += 1;
      try {
        return fn();
      } finally {
        this.transactionDepth -= 1;
      }
    }
    this.transactionDepth += 1;
    this.db.exec("BEGIN");
    try {
      const value = fn();
      this.db.exec("COMMIT");
      this.transactionDepth -= 1;
      return value;
    } catch (err) {
      this.db.exec("ROLLBACK");
      this.transactionDepth -= 1;
      throw err;
    }
  }
}

export async function openDatabase(): Promise<AppDb> {
  const dbPath = path.resolve(process.cwd(), process.env.AUTOPILOT_DB_PATH || "backend/data/autopilot.sqlite");
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });

  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.pragma("synchronous = NORMAL");
  db.pragma("foreign_keys = ON");
  // Wait up to 5s for a lock instead of failing immediately — brief contention
  // (e.g. the backup VACUUM INTO overlapping a write) should retry, not error.
  db.pragma("busy_timeout = 5000");

  const appDb = new AppDb(db);
  migrate(appDb);
  return appDb;
}

function migrate(db: AppDb): void {
  db.exec(`
    PRAGMA foreign_keys = ON;

    CREATE TABLE IF NOT EXISTS clients (
      id TEXT PRIMARY KEY,
      company_name TEXT NOT NULL DEFAULT '',
      contact_name TEXT NOT NULL DEFAULT '',
      contact_email TEXT NOT NULL DEFAULT '',
      phone TEXT NOT NULL DEFAULT '',
      billing_status TEXT NOT NULL DEFAULT '',
      notes TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS portal_profiles (
      id TEXT PRIMARY KEY,
      client_id TEXT,
      portal_name TEXT NOT NULL,
      portal_type TEXT NOT NULL,
      portal_url TEXT NOT NULL DEFAULT '',
      username_reference TEXT NOT NULL DEFAULT '',
      encrypted_storage_state TEXT NOT NULL DEFAULT '',
      mfa_required INTEGER NOT NULL DEFAULT 0,
      captcha_expected INTEGER NOT NULL DEFAULT 0,
      last_login_success_at TEXT,
      notes TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL,
      FOREIGN KEY (client_id) REFERENCES clients(id)
    );

    CREATE TABLE IF NOT EXISTS projects (
      id TEXT PRIMARY KEY,
      client_id TEXT,
      homeowner_name TEXT NOT NULL DEFAULT '',
      project_address TEXT NOT NULL DEFAULT '',
      city TEXT NOT NULL DEFAULT '',
      state TEXT NOT NULL DEFAULT '',
      zip TEXT NOT NULL DEFAULT '',
      ahj TEXT NOT NULL DEFAULT '',
      utility TEXT NOT NULL DEFAULT '',
      account_number TEXT NOT NULL DEFAULT '',
      meter_number TEXT NOT NULL DEFAULT '',
      system_size_dc_kw REAL,
      system_size_ac_kw REAL,
      total_export_kw REAL,
      interconnection_method TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL,
      current_stage TEXT NOT NULL DEFAULT '',
      parser_confidence_summary TEXT NOT NULL DEFAULT '',
      parser_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY (client_id) REFERENCES clients(id)
    );

    CREATE TABLE IF NOT EXISTS source_files (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      file_type TEXT NOT NULL,
      original_filename TEXT NOT NULL DEFAULT '',
      stored_path TEXT NOT NULL DEFAULT '',
      extracted_text TEXT NOT NULL DEFAULT '',
      ocr_used INTEGER NOT NULL DEFAULT 0,
      confidence REAL,
      uploaded_at TEXT NOT NULL,
      FOREIGN KEY (project_id) REFERENCES projects(id)
    );

    CREATE TABLE IF NOT EXISTS extracted_fields (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      field_name TEXT NOT NULL,
      field_value TEXT NOT NULL DEFAULT '',
      source_file_id TEXT,
      source_method TEXT NOT NULL DEFAULT '',
      confidence REAL,
      human_verified INTEGER NOT NULL DEFAULT 0,
      notes TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL,
      FOREIGN KEY (project_id) REFERENCES projects(id),
      FOREIGN KEY (source_file_id) REFERENCES source_files(id)
    );

    CREATE TABLE IF NOT EXISTS qc_results (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      qc_status TEXT NOT NULL,
      rule_id TEXT NOT NULL,
      rule_name TEXT NOT NULL,
      message TEXT NOT NULL,
      severity TEXT NOT NULL,
      created_at TEXT NOT NULL,
      FOREIGN KEY (project_id) REFERENCES projects(id)
    );

    CREATE TABLE IF NOT EXISTS ahj_library (
      id TEXT PRIMARY KEY,
      ahj_name TEXT NOT NULL,
      state TEXT NOT NULL DEFAULT '',
      county TEXT NOT NULL DEFAULT '',
      portal_name TEXT NOT NULL DEFAULT '',
      portal_url TEXT NOT NULL DEFAULT '',
      permit_types TEXT NOT NULL DEFAULT '',
      file_naming_profile TEXT NOT NULL DEFAULT '',
      required_documents TEXT NOT NULL DEFAULT '',
      known_rejection_patterns TEXT NOT NULL DEFAULT '',
      notes TEXT NOT NULL DEFAULT ''
    );

    CREATE TABLE IF NOT EXISTS utility_library (
      id TEXT PRIMARY KEY,
      utility_name TEXT NOT NULL,
      state TEXT NOT NULL DEFAULT '',
      portal_name TEXT NOT NULL DEFAULT '',
      portal_url TEXT NOT NULL DEFAULT '',
      nem_process TEXT NOT NULL DEFAULT '',
      required_documents TEXT NOT NULL DEFAULT '',
      known_rejection_patterns TEXT NOT NULL DEFAULT '',
      account_number_pattern TEXT NOT NULL DEFAULT '',
      meter_number_pattern TEXT NOT NULL DEFAULT '',
      notes TEXT NOT NULL DEFAULT ''
    );

    CREATE TABLE IF NOT EXISTS permit_utility_knowledge (
      id TEXT PRIMARY KEY,
      profile_key TEXT NOT NULL UNIQUE,
      state TEXT NOT NULL DEFAULT '',
      ahj TEXT NOT NULL DEFAULT '',
      utility TEXT NOT NULL DEFAULT '',
      portal_name TEXT NOT NULL DEFAULT '',
      portal_url TEXT NOT NULL DEFAULT '',
      required_documents_json TEXT NOT NULL DEFAULT '[]',
      average_timeline_days REAL,
      timeline_sample_count INTEGER NOT NULL DEFAULT 0,
      timeline_notes_json TEXT NOT NULL DEFAULT '[]',
      common_corrections_json TEXT NOT NULL DEFAULT '[]',
      project_count INTEGER NOT NULL DEFAULT 0,
      correction_count INTEGER NOT NULL DEFAULT 0,
      confidence TEXT NOT NULL DEFAULT 'seeded',
      sources_json TEXT NOT NULL DEFAULT '[]',
      notes TEXT NOT NULL DEFAULT '',
      first_seen_at TEXT NOT NULL,
      last_learned_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS knowledge_events (
      id TEXT PRIMARY KEY,
      profile_key TEXT NOT NULL,
      project_id TEXT,
      event_type TEXT NOT NULL,
      details TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL,
      FOREIGN KEY (project_id) REFERENCES projects(id),
      FOREIGN KEY (profile_key) REFERENCES permit_utility_knowledge(profile_key)
    );

    CREATE TABLE IF NOT EXISTS historical_project_fingerprints (
      project_id TEXT PRIMARY KEY,
      profile_key TEXT NOT NULL,
      state TEXT NOT NULL DEFAULT '',
      ahj TEXT NOT NULL DEFAULT '',
      utility TEXT NOT NULL DEFAULT '',
      portal_name TEXT NOT NULL DEFAULT '',
      feature_tags_json TEXT NOT NULL DEFAULT '[]',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY (project_id) REFERENCES projects(id),
      FOREIGN KEY (profile_key) REFERENCES permit_utility_knowledge(profile_key)
    );

    CREATE TABLE IF NOT EXISTS historical_failure_examples (
      id TEXT PRIMARY KEY,
      source_signature TEXT NOT NULL UNIQUE,
      profile_key TEXT NOT NULL,
      project_id TEXT,
      state TEXT NOT NULL DEFAULT '',
      ahj TEXT NOT NULL DEFAULT '',
      utility TEXT NOT NULL DEFAULT '',
      portal_name TEXT NOT NULL DEFAULT '',
      feature_tags_json TEXT NOT NULL DEFAULT '[]',
      outcome TEXT NOT NULL DEFAULT 'rejected_or_delayed',
      correction_bucket TEXT NOT NULL DEFAULT '',
      root_cause TEXT NOT NULL DEFAULT '',
      required_action TEXT NOT NULL DEFAULT '',
      sample TEXT NOT NULL DEFAULT '',
      source_type TEXT NOT NULL DEFAULT '',
      source_label TEXT NOT NULL DEFAULT '',
      occurred_at TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL,
      FOREIGN KEY (project_id) REFERENCES projects(id),
      FOREIGN KEY (profile_key) REFERENCES permit_utility_knowledge(profile_key)
    );

    CREATE TABLE IF NOT EXISTS mbox_learning_records (
      id TEXT PRIMARY KEY,
      source_signature TEXT NOT NULL UNIQUE,
      source_label TEXT NOT NULL DEFAULT '',
      bucket TEXT NOT NULL,
      workflow TEXT NOT NULL DEFAULT '',
      profile_key TEXT NOT NULL DEFAULT '',
      state TEXT NOT NULL DEFAULT '',
      jurisdiction TEXT NOT NULL DEFAULT '',
      utility TEXT NOT NULL DEFAULT '',
      portal_name TEXT NOT NULL DEFAULT '',
      project_address_hash TEXT NOT NULL DEFAULT '',
      project_address_redacted TEXT NOT NULL DEFAULT '',
      correction_category TEXT NOT NULL DEFAULT '',
      correction_subcategory TEXT NOT NULL DEFAULT '',
      required_action TEXT NOT NULL DEFAULT '',
      preventable INTEGER NOT NULL DEFAULT 0,
      required_documents_json TEXT NOT NULL DEFAULT '[]',
      timeline_signal TEXT NOT NULL DEFAULT '',
      status_label TEXT NOT NULL DEFAULT '',
      classifier TEXT NOT NULL DEFAULT 'deterministic',
      confidence REAL NOT NULL DEFAULT 0,
      sample TEXT NOT NULL DEFAULT '',
      occurred_at TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL,
      FOREIGN KEY (profile_key) REFERENCES permit_utility_knowledge(profile_key)
    );

    CREATE TABLE IF NOT EXISTS rules (
      id TEXT PRIMARY KEY,
      rule_type TEXT NOT NULL,
      jurisdiction_scope TEXT NOT NULL DEFAULT '',
      utility_scope TEXT NOT NULL DEFAULT '',
      trigger TEXT NOT NULL DEFAULT '',
      condition TEXT NOT NULL DEFAULT '',
      action TEXT NOT NULL DEFAULT '',
      severity TEXT NOT NULL DEFAULT '',
      source TEXT NOT NULL DEFAULT '',
      active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS submissions (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      portal_profile_id TEXT,
      submission_type TEXT NOT NULL,
      status TEXT NOT NULL,
      application_number TEXT NOT NULL DEFAULT '',
      permit_number TEXT NOT NULL DEFAULT '',
      confirmation_number TEXT NOT NULL DEFAULT '',
      submitted_at TEXT,
      submitted_by TEXT NOT NULL DEFAULT '',
      screenshots_path TEXT NOT NULL DEFAULT '',
      notes TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL,
      FOREIGN KEY (project_id) REFERENCES projects(id),
      FOREIGN KEY (portal_profile_id) REFERENCES portal_profiles(id)
    );

    CREATE TABLE IF NOT EXISTS portal_runs (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      portal_profile_id TEXT,
      run_type TEXT NOT NULL,
      status TEXT NOT NULL,
      started_at TEXT NOT NULL,
      finished_at TEXT,
      error_message TEXT NOT NULL DEFAULT '',
      human_action_required INTEGER NOT NULL DEFAULT 0,
      screenshots_path TEXT NOT NULL DEFAULT '',
      logs_path TEXT NOT NULL DEFAULT '',
      result_json TEXT NOT NULL DEFAULT '{}',
      FOREIGN KEY (project_id) REFERENCES projects(id),
      FOREIGN KEY (portal_profile_id) REFERENCES portal_profiles(id)
    );

    CREATE TABLE IF NOT EXISTS corrections (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      source TEXT NOT NULL,
      correction_text TEXT NOT NULL,
      correction_bucket TEXT NOT NULL,
      root_cause TEXT NOT NULL DEFAULT '',
      required_action TEXT NOT NULL DEFAULT '',
      assigned_to TEXT NOT NULL DEFAULT '',
      draft_response TEXT NOT NULL DEFAULT '',
      human_approved INTEGER NOT NULL DEFAULT 0,
      resubmitted INTEGER NOT NULL DEFAULT 0,
      new_rule_recommended INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      closed_at TEXT,
      FOREIGN KEY (project_id) REFERENCES projects(id)
    );

    CREATE TABLE IF NOT EXISTS permit_check_targets (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      jurisdiction TEXT NOT NULL DEFAULT '',
      portal_name TEXT NOT NULL DEFAULT '',
      portal_url TEXT NOT NULL DEFAULT '',
      application_number TEXT NOT NULL DEFAULT '',
      permit_number TEXT NOT NULL DEFAULT '',
      check_frequency_days INTEGER NOT NULL DEFAULT 7,
      active INTEGER NOT NULL DEFAULT 1,
      last_checked_at TEXT,
      next_check_at TEXT,
      latest_outcome TEXT,
      latest_status_label TEXT NOT NULL DEFAULT '',
      notes TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY (project_id) REFERENCES projects(id)
    );

    CREATE TABLE IF NOT EXISTS permit_status_checks (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      target_id TEXT,
      source TEXT NOT NULL,
      raw_status_text TEXT NOT NULL DEFAULT '',
      status_label TEXT NOT NULL DEFAULT '',
      outcome TEXT NOT NULL,
      confidence REAL NOT NULL DEFAULT 0,
      correction_id TEXT,
      reviewed_by_ahj INTEGER NOT NULL DEFAULT 0,
      ready_for_issue INTEGER NOT NULL DEFAULT 0,
      issue_fee_due INTEGER NOT NULL DEFAULT 0,
      application_number TEXT NOT NULL DEFAULT '',
      permit_number TEXT NOT NULL DEFAULT '',
      message TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL,
      FOREIGN KEY (project_id) REFERENCES projects(id),
      FOREIGN KEY (target_id) REFERENCES permit_check_targets(id),
      FOREIGN KEY (correction_id) REFERENCES corrections(id)
    );

    CREATE TABLE IF NOT EXISTS email_tracking_sources (
      id TEXT PRIMARY KEY,
      source_type TEXT NOT NULL DEFAULT 'mbox_path',
      label TEXT NOT NULL DEFAULT '',
      file_path TEXT NOT NULL UNIQUE,
      default_state TEXT NOT NULL DEFAULT '',
      default_ahj TEXT NOT NULL DEFAULT '',
      default_utility TEXT NOT NULL DEFAULT '',
      active INTEGER NOT NULL DEFAULT 1,
      last_checked_at TEXT,
      last_message_count INTEGER NOT NULL DEFAULT 0,
      last_matched_count INTEGER NOT NULL DEFAULT 0,
      last_error TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS email_project_matches (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      source_id TEXT,
      source_signature TEXT NOT NULL UNIQUE,
      source_label TEXT NOT NULL DEFAULT '',
      email_bucket TEXT NOT NULL DEFAULT '',
      workflow TEXT NOT NULL DEFAULT '',
      confidence REAL NOT NULL DEFAULT 0,
      match_reason TEXT NOT NULL DEFAULT '',
      status_check_id TEXT,
      correction_id TEXT,
      subject TEXT NOT NULL DEFAULT '',
      occurred_at TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL,
      FOREIGN KEY (project_id) REFERENCES projects(id),
      FOREIGN KEY (source_id) REFERENCES email_tracking_sources(id),
      FOREIGN KEY (status_check_id) REFERENCES permit_status_checks(id),
      FOREIGN KEY (correction_id) REFERENCES corrections(id)
    );

    CREATE TABLE IF NOT EXISTS human_review_items (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      issue_type TEXT NOT NULL,
      field_name TEXT NOT NULL,
      parser_value TEXT NOT NULL DEFAULT '',
      llm_suggested_value TEXT NOT NULL DEFAULT '',
      source_excerpt TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL,
      notes TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY (project_id) REFERENCES projects(id)
    );

    CREATE TABLE IF NOT EXISTS operation_steps (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      phase_key TEXT NOT NULL,
      phase_name TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'not_started',
      status_source TEXT NOT NULL DEFAULT 'system',
      owner_role TEXT NOT NULL DEFAULT '',
      due_at TEXT,
      summary TEXT NOT NULL DEFAULT '',
      next_action TEXT NOT NULL DEFAULT '',
      notes TEXT NOT NULL DEFAULT '',
      sort_order INTEGER NOT NULL DEFAULT 0,
      source TEXT NOT NULL DEFAULT 'system',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(project_id, phase_key),
      FOREIGN KEY (project_id) REFERENCES projects(id)
    );

    CREATE TABLE IF NOT EXISTS project_notes (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      note_type TEXT NOT NULL DEFAULT 'pm_note',
      body TEXT NOT NULL DEFAULT '',
      created_by TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL,
      FOREIGN KEY (project_id) REFERENCES projects(id)
    );

    CREATE TABLE IF NOT EXISTS audit_logs (
      id TEXT PRIMARY KEY,
      project_id TEXT,
      actor_type TEXT NOT NULL,
      actor_name TEXT NOT NULL DEFAULT '',
      action TEXT NOT NULL,
      details TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL,
      FOREIGN KEY (project_id) REFERENCES projects(id)
    );

    CREATE INDEX IF NOT EXISTS idx_projects_status ON projects(status);
    CREATE INDEX IF NOT EXISTS idx_qc_project ON qc_results(project_id);
    CREATE INDEX IF NOT EXISTS idx_review_project_status ON human_review_items(project_id, status);
    CREATE INDEX IF NOT EXISTS idx_corrections_project ON corrections(project_id);
    CREATE INDEX IF NOT EXISTS idx_permit_targets_project ON permit_check_targets(project_id);
    CREATE INDEX IF NOT EXISTS idx_permit_targets_due ON permit_check_targets(active, next_check_at);
    CREATE INDEX IF NOT EXISTS idx_permit_checks_project ON permit_status_checks(project_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_email_tracking_active ON email_tracking_sources(active, updated_at);
    CREATE INDEX IF NOT EXISTS idx_email_matches_project ON email_project_matches(project_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_operation_steps_project ON operation_steps(project_id, sort_order);
    CREATE INDEX IF NOT EXISTS idx_project_notes_project ON project_notes(project_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_knowledge_lookup ON permit_utility_knowledge(state, ahj, utility);
    CREATE INDEX IF NOT EXISTS idx_knowledge_events_profile ON knowledge_events(profile_key, created_at);
    CREATE INDEX IF NOT EXISTS idx_knowledge_events_project ON knowledge_events(project_id);
    CREATE INDEX IF NOT EXISTS idx_historical_fingerprints_profile ON historical_project_fingerprints(profile_key);
    CREATE INDEX IF NOT EXISTS idx_historical_failures_profile ON historical_failure_examples(profile_key, created_at);
    CREATE INDEX IF NOT EXISTS idx_historical_failures_lookup ON historical_failure_examples(state, ahj, utility);
    CREATE INDEX IF NOT EXISTS idx_mbox_learning_profile ON mbox_learning_records(profile_key, bucket, occurred_at);
    CREATE INDEX IF NOT EXISTS idx_mbox_learning_bucket ON mbox_learning_records(bucket, workflow, occurred_at);
    CREATE INDEX IF NOT EXISTS idx_audit_project ON audit_logs(project_id);

    CREATE TABLE IF NOT EXISTS client_portal_identities (
      id TEXT PRIMARY KEY,
      client_id TEXT NOT NULL,
      portal_type TEXT NOT NULL DEFAULT '',
      installer_company_label TEXT NOT NULL DEFAULT '',
      installer_contact_code TEXT NOT NULL DEFAULT '',
      notes TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL,
      FOREIGN KEY (client_id) REFERENCES clients(id)
    );
    CREATE INDEX IF NOT EXISTS idx_client_portal_identities_client ON client_portal_identities(client_id);

    -- Users (operators working in the pipeline)
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      email TEXT NOT NULL UNIQUE,
      role TEXT NOT NULL DEFAULT 'operator',
      color TEXT NOT NULL DEFAULT '#6366f1',
      active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL
    );

    -- Job queue for async work (MBOX imports, permit checks, portal runs)
    CREATE TABLE IF NOT EXISTS job_queue (
      id TEXT PRIMARY KEY,
      job_type TEXT NOT NULL,
      payload TEXT NOT NULL DEFAULT '{}',
      status TEXT NOT NULL DEFAULT 'pending',
      priority INTEGER NOT NULL DEFAULT 5,
      assigned_to_user TEXT,
      project_id TEXT,
      created_at TEXT NOT NULL,
      scheduled_at TEXT,
      started_at TEXT,
      finished_at TEXT,
      progress INTEGER NOT NULL DEFAULT 0,
      progress_total INTEGER NOT NULL DEFAULT 0,
      result TEXT,
      error TEXT,
      retry_count INTEGER NOT NULL DEFAULT 0,
      max_retries INTEGER NOT NULL DEFAULT 3
    );
    CREATE INDEX IF NOT EXISTS idx_job_queue_status ON job_queue(status, priority DESC, scheduled_at);
    CREATE INDEX IF NOT EXISTS idx_job_queue_project ON job_queue(project_id);

    -- KPI metrics snapshot per project (updated on key lifecycle events)
    CREATE TABLE IF NOT EXISTS project_metrics (
      project_id TEXT PRIMARY KEY,
      submitted_at TEXT,
      permit_issued_at TEXT,
      nem_approved_at TEXT,
      pto_at TEXT,
      first_correction_at TEXT,
      last_correction_at TEXT,
      correction_count INTEGER NOT NULL DEFAULT 0,
      permit_cycle_days REAL,
      nem_cycle_days REAL,
      total_cycle_days REAL,
      sla_breaches INTEGER NOT NULL DEFAULT 0,
      assigned_user_id TEXT,
      updated_at TEXT NOT NULL,
      FOREIGN KEY (project_id) REFERENCES projects(id)
    );
    CREATE INDEX IF NOT EXISTS idx_project_metrics_user ON project_metrics(assigned_user_id);
    CREATE INDEX IF NOT EXISTS idx_project_metrics_submitted ON project_metrics(submitted_at);

    -- AHJ blank form templates (PDF bytes stored as BLOB, wiped after extraction)
    -- moat_data stores extracted field positions/structure so the blank is re-generatable
    CREATE TABLE IF NOT EXISTS ahj_form_templates (
      id TEXT PRIMARY KEY,
      ahj_name TEXT NOT NULL,
      state TEXT NOT NULL DEFAULT '',
      form_type TEXT NOT NULL DEFAULT 'permit_application',
      original_filename TEXT NOT NULL DEFAULT '',
      pdf_blob BLOB,
      moat_data TEXT NOT NULL DEFAULT '{}',
      field_map TEXT NOT NULL DEFAULT '{}',
      notes TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_ahj_form_templates_ahj ON ahj_form_templates(ahj_name, state);

    -- Customers / leads: the homeowner side of a deal, tracked before (and
    -- after) a project packet exists. client_id is the installer who referred
    -- them; project_id links once the lead becomes a real project.
    CREATE TABLE IF NOT EXISTS customers (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL DEFAULT '',
      email TEXT NOT NULL DEFAULT '',
      phone TEXT NOT NULL DEFAULT '',
      address TEXT NOT NULL DEFAULT '',
      city TEXT NOT NULL DEFAULT '',
      state TEXT NOT NULL DEFAULT '',
      zip TEXT NOT NULL DEFAULT '',
      lead_source TEXT NOT NULL DEFAULT '',
      lead_stage TEXT NOT NULL DEFAULT 'new_lead',
      client_id TEXT,
      assigned_user_id TEXT,
      notes TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY (client_id) REFERENCES clients(id)
    );
    CREATE INDEX IF NOT EXISTS idx_customers_stage ON customers(lead_stage, updated_at);

    -- Communication log: one row per touch (email/call/text/note) tied to a
    -- customer and/or project. Plain operational history — no secrets stored.
    CREATE TABLE IF NOT EXISTS communications (
      id TEXT PRIMARY KEY,
      customer_id TEXT,
      project_id TEXT,
      direction TEXT NOT NULL DEFAULT 'outbound',
      channel TEXT NOT NULL DEFAULT 'note',
      subject TEXT NOT NULL DEFAULT '',
      body TEXT NOT NULL DEFAULT '',
      logged_by TEXT NOT NULL DEFAULT '',
      occurred_at TEXT NOT NULL,
      created_at TEXT NOT NULL,
      FOREIGN KEY (customer_id) REFERENCES customers(id),
      FOREIGN KEY (project_id) REFERENCES projects(id)
    );
    CREATE INDEX IF NOT EXISTS idx_comms_customer ON communications(customer_id, occurred_at);
    CREATE INDEX IF NOT EXISTS idx_comms_project ON communications(project_id, occurred_at);
  `);

  // Additive licensing/contractor columns on the existing clients table.
  // Uses addColumnIfMissing so databases created before these fields existed
  // pick them up without losing data.
  for (const [column, ddl] of CLIENT_LICENSING_COLUMNS) {
    addColumnIfMissing(db, "clients", column, ddl);
  }

  for (const [column, ddl] of CORRECTION_SLA_COLUMNS) {
    addColumnIfMissing(db, "corrections", column, ddl);
  }

  // target_type distinguishes permit vs NEM/interconnection check targets
  addColumnIfMissing(db, "permit_check_targets", "target_type", "TEXT NOT NULL DEFAULT 'permit'");
  // project-level user assignment
  addColumnIfMissing(db, "projects", "assigned_user_id", "TEXT");
  // link a project back to the customer/lead it came from
  addColumnIfMissing(db, "projects", "customer_id", "TEXT");
  // password auth (used only when AUTH_ENABLED=true)
  addColumnIfMissing(db, "users", "password_hash", "TEXT NOT NULL DEFAULT ''");
  // AHJ portal platform (Accela/ProjectDox/EnerGov…) + submission method — drives
  // portal-automation reuse (one Playwright driver per platform across AHJs).
  addColumnIfMissing(db, "permit_utility_knowledge", "portal_platform", "TEXT NOT NULL DEFAULT ''");
  addColumnIfMissing(db, "permit_utility_knowledge", "submission_method", "TEXT NOT NULL DEFAULT ''");

  // Scale indexes (built after the migrated columns exist) — keep the project
  // list snappy with thousands of rows: default sort is updated_at DESC, with
  // common filters on assigned user, client, and customer.
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_projects_updated ON projects(updated_at DESC);
    CREATE INDEX IF NOT EXISTS idx_projects_created ON projects(created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_projects_assigned ON projects(assigned_user_id);
    CREATE INDEX IF NOT EXISTS idx_projects_client ON projects(client_id);
    CREATE INDEX IF NOT EXISTS idx_projects_customer ON projects(customer_id);
    CREATE INDEX IF NOT EXISTS idx_projects_status_updated ON projects(status, updated_at DESC);
  `);

  // Portal record/replay recipes — teach the bot a new AHJ or utility portal by
  // recording the steps once, then replay them. One row per profile_key (latest
  // version wins); admins can delete + re-record.
  db.exec(`
    CREATE TABLE IF NOT EXISTS portal_recipes (
      id TEXT PRIMARY KEY,
      scope_type TEXT NOT NULL DEFAULT 'ahj',
      profile_key TEXT NOT NULL,
      state TEXT NOT NULL DEFAULT '',
      ahj TEXT NOT NULL DEFAULT '',
      utility TEXT NOT NULL DEFAULT '',
      portal_platform TEXT NOT NULL DEFAULT '',
      portal_url TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'recording',
      version INTEGER NOT NULL DEFAULT 1,
      steps_json TEXT NOT NULL DEFAULT '[]',
      created_by TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      notes TEXT NOT NULL DEFAULT ''
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_portal_recipes_profile ON portal_recipes(profile_key);
    CREATE INDEX IF NOT EXISTS idx_portal_recipes_status ON portal_recipes(status);
  `);

  seedBaselineRuleRows(db);
  seedInitialKnowledgeBase(db);
  seedTestInstaller(db);
}

// Seeds the primary test installer (TML INTERNATIONAL LLC) so project flows can
// be exercised end-to-end before onboarding live installers. Idempotent: only
// inserts if a client with this CCB does not already exist, so edits made in the
// UI survive within a database. Because the dev DB is ephemeral, this keeps the
// test client available in every fresh environment. Turn it off for go-live with
// SEED_TEST_INSTALLER=false (then onboard real installers through the Clients UI).
function seedTestInstaller(db: AppDb): void {
  if (process.env.SEED_TEST_INSTALLER === "false") return;
  const ccb = "223690";
  const existing = db.get<{ id: string }>("SELECT id FROM clients WHERE ccb_license_number = ?", [ccb]);
  if (existing) return;
  db.run(
    `INSERT INTO clients (
       id, company_name, legal_business_name, contact_name, contact_email, phone,
       billing_status, notes,
       ccb_license_number, electrical_license_number, metro_city_license_number,
       electrical_supervisor_name, electrician_license_number,
       business_address, business_city, business_state, business_zip,
       business_phone, business_email, created_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      "tml-international-llc",
      "TML INTERNATIONAL LLC",
      "TML INTERNATIONAL LLC",
      "Charles Bitton",
      "permit@infinitysolarusa.com",
      "(800) 818-0598",
      "active",
      "Primary test installer for validating project flows prior to go-live. Onboarded from installer profile; verify licensing before any real submittal.",
      ccb,
      "C1556",
      "14838",
      "Charles Bitton",
      "5787S",
      "808 SE Chkalov Dr ST 3-337",
      "Vancouver",
      "WA",
      "98683",
      "(800) 818-0598",
      "permit@infinitysolarusa.com",
      "2026-06-21T00:00:00.000Z",
    ],
  );
}

const CLIENT_LICENSING_COLUMNS: [string, string][] = [
  ["legal_business_name", "TEXT NOT NULL DEFAULT ''"],
  ["dba", "TEXT NOT NULL DEFAULT ''"],
  ["ccb_license_number", "TEXT NOT NULL DEFAULT ''"],
  ["ccb_expiration", "TEXT NOT NULL DEFAULT ''"],
  ["electrical_license_number", "TEXT NOT NULL DEFAULT ''"],
  ["metro_city_license_number", "TEXT NOT NULL DEFAULT ''"],
  ["electrical_supervisor_name", "TEXT NOT NULL DEFAULT ''"],
  ["electrician_license_number", "TEXT NOT NULL DEFAULT ''"],
  ["business_address", "TEXT NOT NULL DEFAULT ''"],
  ["business_city", "TEXT NOT NULL DEFAULT ''"],
  ["business_state", "TEXT NOT NULL DEFAULT ''"],
  ["business_zip", "TEXT NOT NULL DEFAULT ''"],
  ["business_phone", "TEXT NOT NULL DEFAULT ''"],
  ["business_email", "TEXT NOT NULL DEFAULT ''"],
  ["ein", "TEXT NOT NULL DEFAULT ''"],
  ["bond_carrier", "TEXT NOT NULL DEFAULT ''"],
  ["insurance_carrier", "TEXT NOT NULL DEFAULT ''"],
  ["authorized_signer_name", "TEXT NOT NULL DEFAULT ''"],
  ["authorized_signer_title", "TEXT NOT NULL DEFAULT ''"],
];

const CORRECTION_SLA_COLUMNS: [string, string][] = [
  ["due_at", "TEXT"],
  ["sla_days", "INTEGER NOT NULL DEFAULT 5"],
];

function addColumnIfMissing(db: AppDb, table: string, column: string, ddl: string): void {
  const cols = db.query<{ name: string }>(`PRAGMA table_info(${table})`);
  if (cols.some((c) => c.name === column)) return;
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${ddl}`);
}

function seedBaselineRuleRows(db: AppDb): void {
  const createdAt = "2026-06-14T00:00:00.000Z";
  for (const rule of baselineRuleDefinitions) {
    db.run(
      `INSERT OR IGNORE INTO rules
        (id, rule_type, jurisdiction_scope, utility_scope, trigger, condition, action, severity, source, active, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        rule.id,
        rule.ruleType,
        rule.jurisdictionScope,
        rule.utilityScope,
        rule.trigger,
        rule.trigger,
        rule.action,
        rule.severity,
        rule.source,
        1,
        createdAt,
      ],
    );
  }
}
