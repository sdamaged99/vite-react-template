/**
 * Applies db/migrations/*.sql that aren't yet recorded in d1_migrations, in
 * name order, each in its own transaction. Uses the same bookkeeping table as
 * wrangler/D1, so a database exported from D1 carries on where it left off.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { SqliteD1 } from "./sqlite-d1";

export function applyMigrations(db: SqliteD1, dir: string, log: (m: string) => void = console.log): string[] {
  db.raw.exec(
    `CREATE TABLE IF NOT EXISTS d1_migrations (
       id INTEGER PRIMARY KEY AUTOINCREMENT,
       name TEXT UNIQUE,
       applied_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
     )`,
  );
  const done = new Set(
    (db.raw.prepare("SELECT name FROM d1_migrations").all() as { name: string }[]).map((r) => r.name),
  );
  const pending = readdirSync(dir)
    .filter((f) => f.endsWith(".sql") && !done.has(f))
    .sort();
  for (const f of pending) {
    const sql = readFileSync(join(dir, f), "utf8");
    db.raw.exec("BEGIN IMMEDIATE");
    try {
      db.raw.exec(sql);
      db.raw.prepare("INSERT INTO d1_migrations (name) VALUES (?)").run(f);
      db.raw.exec("COMMIT");
      log(`applied ${f}`);
    } catch (e) {
      db.raw.exec("ROLLBACK");
      throw new Error(`Migration ${f} failed: ${(e as Error).message}`);
    }
  }
  if (pending.length === 0) log("database is up to date");
  return pending;
}
