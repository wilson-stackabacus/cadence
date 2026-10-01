// Database access. Uses Turso (libSQL) when TURSO_DATABASE_URL is set,
// otherwise a local SQLite file with the exact same API — handy for development.
import { createClient } from '@libsql/client';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

function makeClient() {
  if (process.env.TURSO_DATABASE_URL) {
    return createClient({ url: process.env.TURSO_DATABASE_URL, authToken: process.env.TURSO_AUTH_TOKEN });
  }
  if (process.env.VERCEL) {
    throw new Error('TURSO_DATABASE_URL and TURSO_AUTH_TOKEN must be set in the Vercel project settings.');
  }
  const file = resolve(here, '..', 'data', 'cadence.db');
  mkdirSync(dirname(file), { recursive: true });
  return createClient({ url: `file:${file}` });
}

export const db = makeClient();
export const usingTurso = Boolean(process.env.TURSO_DATABASE_URL);

let migrated;
/** Serverless instances start cold; create tables once per instance (cheap no-op afterwards). */
export const ready = () => (migrated ??= migrate().catch(e => { migrated = undefined; throw e; }));

async function migrate() {
  await db.batch([
    `CREATE TABLE IF NOT EXISTS users (
       id TEXT PRIMARY KEY,
       username TEXT NOT NULL UNIQUE COLLATE NOCASE,
       password_hash TEXT NOT NULL,
       seq INTEGER NOT NULL DEFAULT 0,          -- per-user sync version counter
       created_at INTEGER NOT NULL
     )`,
    `CREATE TABLE IF NOT EXISTS sessions (
       token_hash TEXT PRIMARY KEY,             -- sha256 of the token; the raw token is never stored
       user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
       device TEXT,
       created_at INTEGER NOT NULL,
       last_seen INTEGER NOT NULL,
       expires_at INTEGER NOT NULL
     )`,
    `CREATE INDEX IF NOT EXISTS sessions_user ON sessions(user_id)`,
    // Every task, reflection and the settings blob is one row. "version" orders changes for sync.
    `CREATE TABLE IF NOT EXISTS records (
       user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
       kind TEXT NOT NULL,                      -- 'task' | 'reflection' | 'settings'
       id TEXT NOT NULL,
       data TEXT,                               -- JSON, same shape the Mac app encodes
       updated_at INTEGER NOT NULL,             -- client edit time (ms), last-writer-wins
       deleted INTEGER NOT NULL DEFAULT 0,
       version INTEGER NOT NULL,
       PRIMARY KEY (user_id, kind, id)
     )`,
    `CREATE INDEX IF NOT EXISTS records_version ON records(user_id, version)`,
    // Serverless functions keep no memory between requests, so these live in the database.
    `CREATE TABLE IF NOT EXISTS login_failures (
       key TEXT PRIMARY KEY, first_at INTEGER NOT NULL, count INTEGER NOT NULL
     )`,
    `CREATE TABLE IF NOT EXISTS oauth_states (
       state TEXT PRIMARY KEY, user_id TEXT NOT NULL, created_at INTEGER NOT NULL
     )`,
    `CREATE TABLE IF NOT EXISTS google_tokens (
       user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
       refresh_token TEXT NOT NULL,
       access_token TEXT,
       expires_at INTEGER,
       email TEXT
     )`,
  ], 'write');
}

const KINDS = new Set(['task', 'reflection', 'settings']);

/**
 * Applies a batch of client changes (last-writer-wins on updatedAt) and returns
 * everything that changed after `since`, plus the new cursor.
 */
export async function sync(userId, since, changes) {
  const tx = await db.transaction('write');
  try {
    const u = await tx.execute({ sql: 'SELECT seq FROM users WHERE id = ?', args: [userId] });
    let seq = Number(u.rows[0].seq);
    for (const c of changes) {
      if (!KINDS.has(c.kind) || typeof c.id !== 'string' || !c.id || c.id.length > 100) continue;
      const id = c.kind === 'settings' ? 'main' : c.id.toUpperCase();
      const updatedAt = Math.floor(Number(c.updatedAt) || 0);
      const data = c.deleted ? null : JSON.stringify(c.data ?? null);
      if (data && data.length > 200_000) continue;
      const cur = await tx.execute({
        sql: 'SELECT updated_at FROM records WHERE user_id = ? AND kind = ? AND id = ?',
        args: [userId, c.kind, id],
      });
      if (cur.rows.length && Number(cur.rows[0].updated_at) > updatedAt) continue; // server copy is newer
      seq += 1;
      await tx.execute({
        sql: `INSERT INTO records (user_id, kind, id, data, updated_at, deleted, version)
              VALUES (?, ?, ?, ?, ?, ?, ?)
              ON CONFLICT (user_id, kind, id) DO UPDATE SET
                data = excluded.data, updated_at = excluded.updated_at,
                deleted = excluded.deleted, version = excluded.version`,
        args: [userId, c.kind, id, data, updatedAt, c.deleted ? 1 : 0, seq],
      });
    }
    await tx.execute({ sql: 'UPDATE users SET seq = ? WHERE id = ?', args: [seq, userId] });
    const out = await tx.execute({
      sql: `SELECT kind, id, data, updated_at, deleted, version FROM records
            WHERE user_id = ? AND version > ? ORDER BY version`,
      args: [userId, Math.max(0, Number(since) || 0)],
    });
    await tx.commit();
    return {
      cursor: seq,
      changes: out.rows.map(r => ({
        kind: r.kind,
        id: r.id,
        updatedAt: Number(r.updated_at),
        deleted: Boolean(r.deleted),
        data: r.data ? JSON.parse(r.data) : null,
      })),
    };
  } catch (e) {
    await tx.rollback().catch(() => {});
    throw e;
  } finally {
    tx.close();
  }
}
