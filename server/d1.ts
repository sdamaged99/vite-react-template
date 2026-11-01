// The subset of the D1 API the Worker code uses, on a local SQLite file.
import { DatabaseSync, type StatementSync } from "node:sqlite";
import { mkdirSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";

type Value = null | number | bigint | string | Uint8Array;

class Statement {
  constructor(
    private readonly db: DatabaseSync,
    private readonly sql: string,
    private readonly args: Value[] = [],
  ) {}

  private prepared(): StatementSync {
    return this.db.prepare(this.sql);
  }

  bind(...args: unknown[]) {
    return new Statement(this.db, this.sql, args.map((a) => (a === undefined ? null : (a as Value))));
  }

  async first<T>(column?: string): Promise<T | null> {
    const row = this.prepared().get(...this.args) as Record<string, unknown> | undefined;
    if (row === undefined) return null;
    return (column ? row[column] : { ...row }) as T;
  }

  async all<T>() {
    const results = this.prepared().all(...this.args).map((r) => ({ ...(r as object) })) as T[];
    return { results, success: true, meta: { changes: 0, last_row_id: 0 } };
  }

  async run() {
    return this.runSync();
  }

  runSync() {
    const r = this.prepared().run(...this.args);
    return { results: [], success: true, meta: { changes: Number(r.changes), last_row_id: Number(r.lastInsertRowid) } };
  }

  /** Used by batch(): reads return rows, writes return their change count. */
  execSync() {
    const st = this.prepared();
    if (st.columns().length > 0) {
      const results = st.all(...this.args).map((r) => ({ ...(r as object) }));
      return { results, success: true, meta: { changes: 0, last_row_id: 0 } };
    }
    return this.runSync();
  }
}

export function openDatabase(path: string, migrationsDir: string) {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA busy_timeout = 5000");
  db.exec("PRAGMA foreign_keys = ON");
  migrate(db, migrationsDir);
  return {
    prepare: (sql: string) => new Statement(db, sql),
    // D1 runs a batch as one transaction, so this must be all-or-nothing too.
    batch: async (statements: Statement[]) => {
      db.exec("BEGIN IMMEDIATE");
      try {
        const out = statements.map((s) => s.execSync());
        db.exec("COMMIT");
        return out;
      } catch (err) {
        db.exec("ROLLBACK");
        throw err;
      }
    },
    close: () => db.close(),
  };
}

/** Applies unapplied db/migrations files once each, in order, at startup. */
function migrate(db: DatabaseSync, dir: string) {
  db.exec(
    "CREATE TABLE IF NOT EXISTS d1_migrations (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE, applied_at TEXT NOT NULL DEFAULT (datetime('now')))",
  );
  const applied = new Set(db.prepare("SELECT name FROM d1_migrations").all().map((r) => String((r as { name: string }).name)));
  for (const file of readdirSync(dir).filter((f) => f.endsWith(".sql")).sort()) {
    if (applied.has(file)) continue;
    db.exec("BEGIN IMMEDIATE");
    try {
      db.exec(readFileSync(join(dir, file), "utf8"));
      db.prepare("INSERT INTO d1_migrations (name) VALUES (?)").run(file);
      db.exec("COMMIT");
      console.log(`migration applied: ${file}`);
    } catch (err) {
      db.exec("ROLLBACK");
      throw new Error(`migration ${file} failed: ${String(err)}`);
    }
  }
}
