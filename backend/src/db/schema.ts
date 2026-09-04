/**
 * 마이그레이션 목록. `migrations` 테이블에 적용된 버전을 기록하고,
 * 아직 적용되지 않은 것만 순서대로 실행한다.
 */
export interface Migration {
  version: number;
  name: string;
  sql: string;
}

export const MIGRATIONS: Migration[] = [
  {
    version: 1,
    name: "initial",
    sql: `
      CREATE TABLE users (
        id TEXT PRIMARY KEY,
        username TEXT NOT NULL UNIQUE,
        password_hash TEXT NOT NULL,
        role TEXT NOT NULL CHECK (role IN ('admin','user')),
        ai_allowed INTEGER NOT NULL DEFAULT 1,
        must_change_password INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE auth_sessions (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        created_at TEXT NOT NULL,
        last_seen_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        user_agent TEXT
      );
      CREATE INDEX idx_auth_sessions_user ON auth_sessions(user_id);

      CREATE TABLE sessions (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        locked INTEGER NOT NULL DEFAULT 0,
        created_by TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE session_members (
        session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        added_at TEXT NOT NULL,
        PRIMARY KEY (session_id, user_id)
      );
      CREATE INDEX idx_session_members_user ON session_members(user_id);

      CREATE TABLE pages (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        type TEXT NOT NULL CHECK (type IN ('canvas','sheet')),
        position INTEGER NOT NULL,
        room_id TEXT NOT NULL,
        room_key TEXT NOT NULL,
        thumbnail BLOB,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX idx_pages_session ON pages(session_id, position);

      CREATE TABLE scenes (
        page_id TEXT PRIMARY KEY REFERENCES pages(id) ON DELETE CASCADE,
        elements TEXT NOT NULL,
        app_state TEXT NOT NULL,
        version INTEGER NOT NULL DEFAULT 0,
        updated_at TEXT NOT NULL,
        updated_by TEXT
      );

      CREATE TABLE scene_snapshots (
        id TEXT PRIMARY KEY,
        page_id TEXT NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
        elements TEXT NOT NULL,
        app_state TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE INDEX idx_scene_snapshots_page ON scene_snapshots(page_id, created_at DESC);

      CREATE TABLE sheets (
        page_id TEXT PRIMARY KEY REFERENCES pages(id) ON DELETE CASCADE,
        data TEXT NOT NULL,
        version INTEGER NOT NULL DEFAULT 0,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE files (
        id TEXT PRIMARY KEY,
        page_id TEXT NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
        mime TEXT NOT NULL,
        size INTEGER NOT NULL,
        path TEXT NOT NULL,
        created_at TEXT NOT NULL,
        created_by TEXT
      );
      CREATE INDEX idx_files_page ON files(page_id);

      CREATE TABLE comments (
        id TEXT PRIMARY KEY,
        page_id TEXT NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
        element_id TEXT,
        x REAL NOT NULL DEFAULT 0,
        y REAL NOT NULL DEFAULT 0,
        author_id TEXT,
        body TEXT NOT NULL,
        resolved INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX idx_comments_page ON comments(page_id, resolved);

      CREATE TABLE comment_replies (
        id TEXT PRIMARY KEY,
        comment_id TEXT NOT NULL REFERENCES comments(id) ON DELETE CASCADE,
        author_id TEXT,
        body TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE INDEX idx_comment_replies_comment ON comment_replies(comment_id);
    `,
  },
];
