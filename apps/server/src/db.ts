import fs from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { config } from './config.js'

/** node:sqlite (stdlib, no native addons) so the server runs identically under
 *  system Node, Electron's embedded Node, and the Docker image. */

let db: DatabaseSync | null = null

export function getDb(): DatabaseSync {
  if (db) return db
  fs.mkdirSync(config.dataDir, { recursive: true })
  db = new DatabaseSync(config.dbPath)
  db.exec('PRAGMA journal_mode = WAL;')
  migrate(db)
  return db
}

function migrate(d: DatabaseSync): void {
  d.exec(`
    CREATE TABLE IF NOT EXISTS secrets (
      name TEXT PRIMARY KEY,
      sealed TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    );

    -- Plain (non-secret) local preferences, e.g. the tool-approval mode.
    CREATE TABLE IF NOT EXISTS app_settings (
      name TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS model_capabilities (
      route_key TEXT PRIMARY KEY,          -- "<group>|<model>|<api_type>"
      model_id TEXT NOT NULL,
      group_name TEXT NOT NULL,
      api_type TEXT NOT NULL,
      declared_context INTEGER,
      verified_context INTEGER,
      effective_context INTEGER NOT NULL,
      -- Always written explicitly by ensureCapability/refreshMaxOutputs (which
      -- size it per model family); this column default only covers hand-written SQL.
      max_output INTEGER NOT NULL DEFAULT 8192,
      source TEXT NOT NULL,                -- botcf-docs | official-docs | omp-catalog | measured
      confidence TEXT NOT NULL,            -- verified | documented | inferred
      last_checked_at INTEGER
    );

    CREATE TABLE IF NOT EXISTS session_routes (
      session_id TEXT NOT NULL,
      changed_at INTEGER NOT NULL,
      group_name TEXT NOT NULL,
      model_id TEXT NOT NULL,
      api_type TEXT NOT NULL,
      token_name TEXT NOT NULL             -- dedicated key NAME only; the key itself lives sealed in secrets
    );

    CREATE TABLE IF NOT EXISTS model_probes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ts INTEGER NOT NULL,
      group_name TEXT NOT NULL,
      model_id TEXT NOT NULL,
      ok INTEGER NOT NULL,                 -- 1 = upstream answered < 400
      status INTEGER NOT NULL              -- HTTP status; 0 = network failure
    );
    CREATE INDEX IF NOT EXISTS idx_model_probes_route_ts ON model_probes(group_name, model_id, ts);
  `)
}

export function putSecret(name: string, sealed: string): void {
  getDb()
    .prepare('INSERT INTO secrets(name, sealed, updated_at) VALUES(?, ?, ?) ON CONFLICT(name) DO UPDATE SET sealed = excluded.sealed, updated_at = excluded.updated_at')
    .run(name, sealed, Date.now())
}

export function getSecret(name: string): string | null {
  const row = getDb().prepare('SELECT sealed FROM secrets WHERE name = ?').get(name) as unknown as { sealed: string } | undefined
  return row?.sealed ?? null
}

export function deleteSecret(name: string): void {
  getDb().prepare('DELETE FROM secrets WHERE name = ?').run(name)
}

export function putSetting(name: string, value: string): void {
  getDb()
    .prepare('INSERT INTO app_settings(name, value, updated_at) VALUES(?, ?, ?) ON CONFLICT(name) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at')
    .run(name, value, Date.now())
}

export function getSetting(name: string): string | null {
  const row = getDb().prepare('SELECT value FROM app_settings WHERE name = ?').get(name) as unknown as { value: string } | undefined
  return row?.value ?? null
}
