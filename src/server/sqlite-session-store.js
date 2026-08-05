'use strict';

const Database = require('better-sqlite3');

function createSqliteSessionStore(session, filename) {
  class SqliteSessionStore extends session.Store {
    constructor() {
      super();
      this.db = new Database(filename);
      this.db.pragma('journal_mode = WAL');
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS sessions_v2 (
          sid TEXT PRIMARY KEY,
          session_json TEXT NOT NULL,
          expires_at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_sessions_v2_expires_at ON sessions_v2(expires_at);
      `);
      this.getStmt = this.db.prepare('SELECT session_json, expires_at FROM sessions_v2 WHERE sid = ?');
      this.setStmt = this.db.prepare(`
        INSERT INTO sessions_v2 (sid, session_json, expires_at) VALUES (?, ?, ?)
        ON CONFLICT(sid) DO UPDATE SET session_json = excluded.session_json, expires_at = excluded.expires_at
      `);
      this.destroyStmt = this.db.prepare('DELETE FROM sessions_v2 WHERE sid = ?');
      this.cleanupStmt = this.db.prepare('DELETE FROM sessions_v2 WHERE expires_at <= ?');
      this.writeCount = 0;
    }

    get(sid, callback) {
      try {
        const row = this.getStmt.get(sid);
        if (!row || row.expires_at <= Date.now()) {
          if (row) this.destroyStmt.run(sid);
          callback(null, null);
          return;
        }
        callback(null, JSON.parse(row.session_json));
      } catch (error) {
        callback(error);
      }
    }

    set(sid, value, callback = () => {}) {
      try {
        const cookieExpiry = value?.cookie?.expires ? new Date(value.cookie.expires).getTime() : 0;
        // v1.3.8: 30-day persistence fallback (was 24h) — session cookies with
        // no explicit expiry must not silently log users out after a day.
        const expiresAt = cookieExpiry || Date.now() + 30 * 24 * 60 * 60 * 1000;
        this.setStmt.run(sid, JSON.stringify(value), expiresAt);
        this.writeCount += 1;
        if (this.writeCount % 100 === 0) this.cleanupStmt.run(Date.now());
        callback(null);
      } catch (error) {
        callback(error);
      }
    }

    destroy(sid, callback = () => {}) {
      try {
        this.destroyStmt.run(sid);
        callback(null);
      } catch (error) {
        callback(error);
      }
    }
  }

  return new SqliteSessionStore();
}

module.exports = { createSqliteSessionStore };
