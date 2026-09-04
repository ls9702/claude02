import { useCallback, useEffect, useState, type FormEvent } from "react";
import { Link } from "react-router-dom";
import { api, ApiError, type AdminSession, type Role, type User } from "../api";
import { Spinner } from "../components/Spinner";
import { UserMenu } from "../components/UserMenu";

type Tab = "users" | "sessions";

export function AdminPage() {
  const [tab, setTab] = useState<Tab>("users");
  const [users, setUsers] = useState<User[] | null>(null);
  const [sessions, setSessions] = useState<AdminSession[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    try {
      const [u, s] = await Promise.all([api.adminListUsers(), api.adminListSessions()]);
      setUsers(u.users);
      setSessions(s.sessions);
      setError(null);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "관리자 정보를 불러오지 못했습니다.");
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  const run = async (action: () => Promise<unknown>) => {
    try {
      await action();
      await reload();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "작업에 실패했습니다.");
    }
  };

  return (
    <div className="page">
      <header className="topbar">
        <Link className="button ghost" to="/">
          ←
        </Link>
        <h1 className="topbar-title">관리자</h1>
        <nav className="tabs" role="tablist">
          <button
            type="button"
            role="tab"
            aria-selected={tab === "users"}
            className={`tab${tab === "users" ? " active" : ""}`}
            data-testid="admin-tab-users"
            onClick={() => setTab("users")}
          >
            사용자
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={tab === "sessions"}
            className={`tab${tab === "sessions" ? " active" : ""}`}
            data-testid="admin-tab-sessions"
            onClick={() => setTab("sessions")}
          >
            세션
          </button>
        </nav>
        <div className="spacer" />
        <UserMenu />
      </header>

      <main className="content">
        {error ? (
          <p className="error" role="alert" data-testid="admin-error">
            {error}
          </p>
        ) : null}
        {users === null || sessions === null ? (
          <Spinner />
        ) : tab === "users" ? (
          <UsersTab users={users} run={run} />
        ) : (
          <SessionsTab sessions={sessions} users={users} run={run} />
        )}
      </main>
    </div>
  );
}

function UsersTab({
  users,
  run,
}: {
  users: User[];
  run: (action: () => Promise<unknown>) => Promise<void>;
}) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [role, setRole] = useState<Role>("user");

  const create = async (event: FormEvent) => {
    event.preventDefault();
    await run(async () => {
      await api.adminCreateUser(username.trim(), password, role);
      setUsername("");
      setPassword("");
      setRole("user");
    });
  };

  return (
    <section>
      <form className="inline-form card" onSubmit={create} data-testid="create-user-form">
        <h2>사용자 추가</h2>
        <input
          placeholder="아이디"
          value={username}
          onChange={(e) => setUsername(e.target.value)}
          data-testid="new-user-username"
          required
        />
        <input
          placeholder="비밀번호 (8자 이상)"
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          data-testid="new-user-password"
          required
        />
        <select value={role} onChange={(e) => setRole(e.target.value as Role)} data-testid="new-user-role">
          <option value="user">일반 사용자</option>
          <option value="admin">관리자</option>
        </select>
        <button type="submit" className="button primary" data-testid="new-user-submit">
          추가
        </button>
      </form>

      <table className="table" data-testid="users-table">
        <thead>
          <tr>
            <th>아이디</th>
            <th>역할</th>
            <th>AI 허용</th>
            <th>작업</th>
          </tr>
        </thead>
        <tbody>
          {users.map((user) => (
            <tr key={user.id} data-testid="user-row" data-username={user.username}>
              <td>{user.username}</td>
              <td>
                <select
                  value={user.role}
                  data-testid="user-role"
                  onChange={(e) => void run(() => api.adminUpdateUser(user.id, { role: e.target.value as Role }))}
                >
                  <option value="user">일반 사용자</option>
                  <option value="admin">관리자</option>
                </select>
              </td>
              <td>
                <input
                  type="checkbox"
                  aria-label={`${user.username} AI 허용`}
                  data-testid="user-ai-allowed"
                  checked={user.ai_allowed}
                  onChange={(e) => void run(() => api.adminUpdateUser(user.id, { ai_allowed: e.target.checked }))}
                />
              </td>
              <td className="row-actions">
                <button
                  type="button"
                  className="button"
                  data-testid="user-reset-password"
                  onClick={() => {
                    const next = window.prompt(`${user.username} 의 새 비밀번호 (8자 이상)`);
                    if (next) void run(() => api.adminUpdateUser(user.id, { password: next }));
                  }}
                >
                  비밀번호 재설정
                </button>
                <button
                  type="button"
                  className="button danger"
                  data-testid="user-delete"
                  onClick={() => {
                    if (window.confirm(`${user.username} 계정을 삭제할까요?`)) {
                      void run(() => api.adminDeleteUser(user.id));
                    }
                  }}
                >
                  삭제
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}

function SessionsTab({
  sessions,
  users,
  run,
}: {
  sessions: AdminSession[];
  users: User[];
  run: (action: () => Promise<unknown>) => Promise<void>;
}) {
  const [name, setName] = useState("");

  const create = async (event: FormEvent) => {
    event.preventDefault();
    await run(async () => {
      await api.adminCreateSession(name.trim());
      setName("");
    });
  };

  return (
    <section>
      <form className="inline-form card" onSubmit={create} data-testid="create-session-form">
        <h2>세션 추가</h2>
        <input
          placeholder="세션 이름"
          value={name}
          onChange={(e) => setName(e.target.value)}
          data-testid="new-session-name"
          required
        />
        <button type="submit" className="button primary" data-testid="new-session-submit">
          추가
        </button>
      </form>

      <ul className="admin-session-list">
        {sessions.map((session) => (
          <li key={session.id} className="card" data-testid="admin-session" data-session-id={session.id}>
            <div className="admin-session-head">
              <input
                className="session-name-input"
                defaultValue={session.name}
                data-testid="admin-session-name"
                onBlur={(e) => {
                  const next = e.target.value.trim();
                  if (next && next !== session.name) void run(() => api.adminUpdateSession(session.id, { name: next }));
                }}
              />
              <label className="checkbox">
                <input
                  type="checkbox"
                  checked={session.locked}
                  data-testid="admin-session-locked"
                  onChange={(e) => void run(() => api.adminUpdateSession(session.id, { locked: e.target.checked }))}
                />
                잠금(읽기 전용)
              </label>
              <span className="muted small">페이지 {session.pages.length}개</span>
              <div className="spacer" />
              <button
                type="button"
                className="button danger"
                data-testid="admin-session-delete"
                onClick={() => {
                  if (window.confirm(`'${session.name}' 세션과 모든 페이지를 삭제할까요?`)) {
                    void run(() => api.adminDeleteSession(session.id));
                  }
                }}
              >
                삭제
              </button>
            </div>
            <div className="member-list">
              <span className="muted small">멤버:</span>
              {users.map((user) => {
                const assigned = session.memberIds.includes(user.id);
                return (
                  <label key={user.id} className="checkbox" data-testid="member-checkbox" data-username={user.username}>
                    <input
                      type="checkbox"
                      checked={assigned}
                      aria-label={`${session.name} 에 ${user.username} 할당`}
                      onChange={(e) =>
                        void run(() =>
                          e.target.checked
                            ? api.adminAddMember(session.id, user.id)
                            : api.adminRemoveMember(session.id, user.id),
                        )
                      }
                    />
                    {user.username}
                  </label>
                );
              })}
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}
