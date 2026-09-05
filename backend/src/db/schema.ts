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
  {
    version: 2,
    name: "page_files_link",
    sql: `
      -- 파일 소유권 모델 변경:
      -- 같은 이미지(같은 Excalidraw fileId)를 여러 페이지에서 쓸 수 있어야 하므로
      -- files 의 page_id 컬럼을 없애고 page_files 링크 테이블로 다대다 관계를 표현한다.
      -- 기존 files 행은 그대로 링크 1개로 옮기고, path 컬럼은 유지한다
      -- (이미 저장된 파일은 디스크에서 옮기지 않는다. 새 업로드만 files/<fileId> 에 저장).
      CREATE TABLE page_files (
        page_id TEXT NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
        file_id TEXT NOT NULL REFERENCES files(id) ON DELETE CASCADE,
        created_at TEXT NOT NULL,
        PRIMARY KEY (page_id, file_id)
      );
      INSERT OR IGNORE INTO page_files (page_id, file_id, created_at)
        SELECT page_id, id, created_at FROM files;
      CREATE INDEX idx_page_files_file ON page_files(file_id);

      CREATE TABLE files_new (
        id TEXT PRIMARY KEY,
        mime TEXT NOT NULL,
        size INTEGER NOT NULL,
        path TEXT NOT NULL,
        created_at TEXT NOT NULL,
        created_by TEXT
      );
      INSERT INTO files_new (id, mime, size, path, created_at, created_by)
        SELECT id, mime, size, path, created_at, created_by FROM files;
      DROP INDEX IF EXISTS idx_files_page;
      DROP TABLE files;
      ALTER TABLE files_new RENAME TO files;
    `,
  },
  {
    version: 3,
    name: "ai_calls_daily",
    sql: `
      -- AI 호출 일별 집계 (관리자 화면 표시용).
      -- 분당 퓨즈는 프로세스 메모리에서 세고(재기동하면 사라져도 되는 값),
      -- 여기에는 "하루에 몇 번 불렀나" 만 남긴다. 질문·답변은 저장하지 않는다.
      CREATE TABLE ai_calls_daily (
        day TEXT PRIMARY KEY,
        count INTEGER NOT NULL DEFAULT 0
      );
    `,
  },
];
