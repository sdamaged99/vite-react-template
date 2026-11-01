/**
 * D1-compatible wrapper over Node's built-in SQLite (node:sqlite, Node ≥ 22.13),
 * covering exactly what the Worker code uses: prepare/bind/first/all/run and
 * batch. batch() is a real transaction (all or nothing), as on D1.
 *
 * One process, synchronous SQLite: writes are naturally serialised, so the
 * guarded INSERT/UPDATE patterns in the routes keep their meaning.
 */
import { DatabaseSync, type StatementSync } from "node:sqlite";

type Value = null | number | bigint | string | Uint8Array;

function toSqlite(v: unknown): Value {
  if (v === undefined || v === null) return null;
  if (typeof v === "boolean") return v ? 1 : 0; // D1 stores booleans as 0/1
  if (typeof v === "number" || typeof v === "bigint" || typeof v === "string") return v;
  if (v instanceof Uint8Array) return v;
  if (v instanceof ArrayBuffer) return new Uint8Array(v);
  throw new TypeError(`Unsupported bind value: ${typeof v}`);
}

const plain = (row: unknown) => {
  if (!row || typeof row !== "object") return row;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(row)) out[k] = typeof v === "bigint" ? Number(v) : v;
  return out;
};

export class SqliteStatement {
  constructor(
    private readonly db: SqliteD1,
    readonly sql: string,
    private readonly params: Value[] = [],
  ) {}
  bind(...values: unknown[]) {
    return new SqliteStatement(this.db, this.sql, values.map(toSqlite));
  }
  private stmt(): StatementSync {
    return this.db.prepareRaw(this.sql);
  }
  async first<T = Record<string, unknown>>(column?: string): Promise<T | null> {
    const row = plain(this.stmt().get(...this.params)) as Record<string, unknown> | undefined;
    if (row === undefined) return null;
    return (column ? (row[column] ?? null) : row) as T;
  }
  async all<T = Record<string, unknown>>() {
    return { results: this.stmt().all(...this.params).map(plain) as T[], success: true, meta: {} };
  }
  async run() {
    const r = this.stmt().run(...this.params);
    return { success: true, results: [], meta: { changes: Number(r.changes), last_row_id: Number(r.lastInsertRowid) } };
  }
  /** Used by batch(): returns rows for queries, change counts for writes. */
  execSync() {
    const st = this.stmt();
    // StatementSync.all() runs any statement; rows are empty for plain writes.
    const results = st.all(...this.params).map(plain);
    return { results, success: true, meta: {} };
  }
}

export class SqliteD1 {
  readonly raw: DatabaseSync;
  private cache = new Map<string, StatementSync>();

  constructor(path: string) {
    this.raw = new DatabaseSync(path);
    this.raw.exec("PRAGMA journal_mode = WAL");
    this.raw.exec("PRAGMA busy_timeout = 5000");
    this.raw.exec("PRAGMA foreign_keys = ON");
    this.raw.exec("PRAGMA synchronous = NORMAL");
  }
  prepareRaw(sql: string): StatementSync {
    let st = this.cache.get(sql);
    if (!st) {
      st = this.raw.prepare(sql);
      if (this.cache.size > 200) this.cache.clear();
      this.cache.set(sql, st);
    }
    return st;
  }
  prepare(sql: string) {
    return new SqliteStatement(this, sql);
  }
  async batch(statements: SqliteStatement[]) {
    this.raw.exec("BEGIN IMMEDIATE");
    try {
      const out = statements.map((s) => s.execSync());
      this.raw.exec("COMMIT");
      return out;
    } catch (e) {
      this.raw.exec("ROLLBACK");
      throw e;
    }
  }
  async exec(sql: string) {
    this.raw.exec(sql);
    return { count: 0, duration: 0 };
  }
  close() {
    this.raw.close();
  }
}
