import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import initSqlJs, { type Database } from "sql.js";
import { baselineRuleDefinitions } from "./baselineRules";
import { seedInitialKnowledgeBase } from "./knowledgeBase";

export type SqlParam = string | number | null | Uint8Array;
export type SqlParams = SqlParam[];

const require = createRequire(import.meta.url);

export class AppDb {
  private transactionDepth = 0;

  constructor(private readonly db: Database, private readonly filePath: string) {}

  query<T = Record<string, unknown>>(sql: string, params: SqlParams = []): T[] {
    const stmt = this.db.prepare(sql);
    const rows: T[] = [];
    try {
      stmt.bind(params);
      while (stmt.step()) rows.push(stmt.getAsObject() as T);
      return rows;
    } finally {
      stmt.free();
    }
  }

  get<T = Record<string, unknown>>(sql: string, params: SqlParams = []): T | null {
    return this.query<T>(sql, params)[0] ?? null;
  }

  run(sql: string, params: SqlParams = []): void {
    this.db.run(sql, params);
    if (this.transactionDepth === 0) this.persist();
  }

  exec(sql: string): void {
    this.db.exec(sql);
    if (this.transactionDepth === 0) this.persist();
  }

  transaction<T>(fn: () => T): T {
    this.transactionDepth += 1;
    this.db.run("BEGIN");
    try {
      const value = fn();
      this.db.run("COMMIT");
      this.transactionDepth -= 1;
      this.persist();
      return value;
    } catch (err) {
      this.db.run("ROLLBACK");
      this.transactionDepth -= 1;
      throw err;
    }
  }

  private persist(): void {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    fs.writeFileSync(this.filePath, Buffer.from(this.db.export()));
  }
}

export async function openDatabase(): Promise<AppDb> {
  const dbPath = path.resolve(process.cwd(), process.env.AUTOPILOT_DB_PATH || "backend/data/autopilot.sqlite");
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });

  const wasmPath = require.resolve("sql.js/dist/sql-wasm.wasm");
  const SQL = await initSqlJs({ locateFile: () => wasmPath });
  const db = fs.existsSync(dbPath)
    ? new SQL.Database(new Uint8Array(fs.readFileSync(dbPath)))
    : new SQL.Database();

  const appDb = new AppDb(db, dbPath);
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
      system_size_dc_kw REAM,
      system_size_ac_kw REAM,
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
  `);
  seedBaselineRuleRows(db);
  seedInitialKnowledgeBase(db);
}

function seedBaselineRuleRows(db: AppDb): void {
  const createdAt = "2026-06-14T00:00:00.000Z";
  for (const rule of baselineRuleDefinitions) {
    db.run(
      `INSERT OR IGNORE INTO rules
        (id, rule_type, jurisdiction_scope, utility_scope, trigger, condition, action, severity, source, active, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [rule.id, rule.ruleType, rule.jurisdictionScope, rule.utilityScope, rule.trigger, rule.trigger, rule.action, rule.severity, rule.source, 1, createdAt],
    );
  }
}
