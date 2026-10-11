// D1 stand-in over node:sqlite with the subset of the API the Worker uses.
import { DatabaseSync } from "node:sqlite";
import { readFileSync, readdirSync } from "node:fs";

class Stmt {
  constructor(private db: DatabaseSync, private sql: string, private args: unknown[] = []) {}
  bind(...args: unknown[]) { return new Stmt(this.db, this.sql, args.map((a) => (a === undefined ? null : a))); }
  private s() { return this.db.prepare(this.sql); }
  async first<T>(col?: string): Promise<T | null> {
    const row = this.s().get(...(this.args as any[])) as any;
    if (row === undefined) return null;
    return (col ? row[col] : { ...row }) as T;
  }
  async all<T>() { return { results: this.s().all(...(this.args as any[])).map((r: any) => ({ ...r })) as T[], success: true }; }
  async run() { const r = this.s().run(...(this.args as any[])); return { success: true, meta: { changes: Number(r.changes), last_row_id: Number(r.lastInsertRowid) } }; }
}

export function makeD1(migrationsDir: string) {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  for (const f of readdirSync(migrationsDir).filter((f) => f.endsWith(".sql")).sort()) {
    db.exec(readFileSync(`${migrationsDir}/${f}`, "utf8"));
  }
  const d1 = {
    prepare: (sql: string) => new Stmt(db, sql),
    batch: async (stmts: Stmt[]) => Promise.all(stmts.map((s) => s.all())),
    raw: db,
  };
  return d1;
}
