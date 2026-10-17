/**
 * ELENVA-FORK: node:sqlite-backed SQLite loader (replaces the upstream
 * better-sqlite3 native-module loader).
 *
 * Upstream pi-hermes-memory loaded the external npm package `better-sqlite3`,
 * a compiled native addon. ELENVA requires zero external npm dependencies and
 * no native builds (`npm i` must never need a toolchain), so this module now
 * adapts Node's built-in `node:sqlite` (`DatabaseSync`) to the same subset of
 * the better-sqlite3 API the rest of the extension uses.
 *
 * API kept (so callers don't change): `new Database(path, options)` with
 * `{ readonly, readOnly, fileMustExist, timeout }`; instance
 * `prepare(sql) -> { run, get, all, iterate }`, `exec(sql)`, `close()`,
 * `pragma(query, { simple })`, `transaction(fn)`, `backup(dest, { progress })`.
 *
 * Differences handled here:
 *   - `node:sqlite` has no `pragma()` / `transaction()` / `backup()` helpers.
 *     `pragma()` reads via `prepare("PRAGMA …")`, `transaction()` wraps with
 *     BEGIN/COMMIT/ROLLBACK, `backup()` uses `VACUUM INTO ?` (consistent
 *     snapshot under a read transaction; no incremental progress callback).
 *   - `fileMustExist` is emulated with an fs.existsSync check before opening.
 *   - `timeout` is applied as `PRAGMA busy_timeout`.
 *
 * `node:sqlite` is still marked experimental in Node, so an
 * `ExperimentalWarning` is printed once per process. We tolerate it rather than
 * silencing warnings or pulling in a dependency.
 */

import fs from "node:fs";
import { DatabaseSync } from "node:sqlite";

export interface SqliteOpenOptions {
  readonly?: boolean;
  /** Alias accepted by the migration shim. */
  readOnly?: boolean;
  fileMustExist?: boolean;
  timeout?: number;
}

export interface SqliteStatement {
  run: (...args: any[]) => { changes: number | bigint; lastInsertRowid: number | bigint };
  get: (...args: any[]) => unknown;
  all: (...args: any[]) => unknown[];
  iterate: (...args: any[]) => Iterable<unknown>;
}

export interface SqliteDatabase {
  prepare(sql: string): SqliteStatement;
  exec(sql: string): void;
  close(): void;
  pragma(query: string, options?: { simple?: boolean }): unknown;
  transaction<T extends (...args: any[]) => any>(fn: T): (...args: Parameters<T>) => ReturnType<T>;
  backup(destination: string, options?: { progress?: () => void }): Promise<void> | void;
}

export type SqliteDatabaseCtor = new (dbPath: string, options?: SqliteOpenOptions) => SqliteDatabase;

/** True when running under Bun (kept for the still-present bun:sqlite branches). */
export function isBunRuntime(): boolean {
  return "Bun" in globalThis;
}

class NodeSqliteDatabase implements SqliteDatabase {
  private readonly db: DatabaseSync;

  constructor(dbPath: string, options: SqliteOpenOptions = {}) {
    const readOnly = options.readonly === true || options.readOnly === true;
    if (options.fileMustExist === true && !readOnly && !fs.existsSync(dbPath)) {
      throw new Error(`SQLite database file does not exist: ${dbPath}`);
    }
    this.db = new DatabaseSync(dbPath, { readOnly });
    if (typeof options.timeout === "number") {
      this.db.exec(`PRAGMA busy_timeout = ${Math.max(0, Math.trunc(options.timeout))}`);
    }
  }

  prepare(sql: string): SqliteStatement {
    return this.db.prepare(sql) as unknown as SqliteStatement;
  }

  exec(sql: string): void {
    this.db.exec(sql);
  }

  close(): void {
    this.db.close();
  }

  pragma(query: string, options?: { simple?: boolean }): unknown {
    if (query.includes("=")) {
      this.db.exec(`PRAGMA ${query}`);
      return undefined;
    }
    const rows = this.db.prepare(`PRAGMA ${query}`).all() as Record<string, unknown>[];
    if (options?.simple) {
      const first = rows[0];
      return first ? Object.values(first)[0] : undefined;
    }
    return rows;
  }

  transaction<T extends (...args: any[]) => any>(fn: T): (...args: Parameters<T>) => ReturnType<T> {
    return ((...args: Parameters<T>): ReturnType<T> => {
      this.db.exec("BEGIN");
      try {
        const result = fn(...args) as ReturnType<T>;
        this.db.exec("COMMIT");
        return result;
      } catch (error) {
        try {
          this.db.exec("ROLLBACK");
        } catch {
          // Preserve the original error; a failed rollback must not mask it.
        }
        throw error;
      }
    }) as (...args: Parameters<T>) => ReturnType<T>;
  }

  /**
   * `VACUUM INTO` writes an equivalent consistent snapshot under a read
   * transaction, but has no incremental callback, so the heartbeat only fires
   * either side of it (same approach the Bun shim already used).
   */
  backup(destination: string, options?: { progress?: () => void }): Promise<void> | void {
    options?.progress?.();
    this.db.prepare("VACUUM INTO ?").run(destination);
    options?.progress?.();
  }
}

/**
 * Resolve the SQLite constructor. Kept lazy (a function, not a module-scope
 * instantiation) to match upstream's "never fail extension load" rule.
 */
export function loadSqliteDatabase(): SqliteDatabaseCtor {
  return NodeSqliteDatabase as unknown as SqliteDatabaseCtor;
}
