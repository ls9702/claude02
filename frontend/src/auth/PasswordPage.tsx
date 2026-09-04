import { useState, type FormEvent } from "react";
import { useNavigate } from "react-router-dom";
import { api, ApiError } from "../api";
import { useAuth } from "./AuthContext";

export function PasswordPage() {
  const { user, setUser } = useAuth();
  const navigate = useNavigate();
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const [busy, setBusy] = useState(false);

  const forced = user?.must_change_password === true;

  const onSubmit = async (event: FormEvent) => {
    event.preventDefault();
    setError(null);
    if (next !== confirm) {
      setError("새 비밀번호가 서로 다릅니다.");
      return;
    }
    setBusy(true);
    try {
      const { user: updated } = await api.changePassword(current, next);
      setUser(updated);
      setDone(true);
      setTimeout(() => navigate("/", { replace: true }), 400);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "비밀번호를 변경하지 못했습니다.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="centered-page">
      <form className="card form" onSubmit={onSubmit}>
        <h1>비밀번호 변경</h1>
        {forced ? (
          <p className="muted">보안을 위해 최초 로그인 시 비밀번호를 변경해야 합니다.</p>
        ) : null}
        <label htmlFor="current">현재 비밀번호</label>
        <input
          id="current"
          type="password"
          autoComplete="current-password"
          value={current}
          onChange={(e) => setCurrent(e.target.value)}
          required
        />
        <label htmlFor="next">새 비밀번호 (8자 이상)</label>
        <input
          id="next"
          type="password"
          autoComplete="new-password"
          value={next}
          onChange={(e) => setNext(e.target.value)}
          required
        />
        <label htmlFor="confirm">새 비밀번호 확인</label>
        <input
          id="confirm"
          type="password"
          autoComplete="new-password"
          value={confirm}
          onChange={(e) => setConfirm(e.target.value)}
          required
        />
        {error ? (
          <p className="error" role="alert">
            {error}
          </p>
        ) : null}
        {done ? <p className="success">비밀번호를 변경했습니다.</p> : null}
        <button type="submit" className="button primary" disabled={busy}>
          {busy ? "변경 중…" : "비밀번호 변경"}
        </button>
        {!forced ? (
          <button type="button" className="button" onClick={() => navigate(-1)}>
            취소
          </button>
        ) : null}
      </form>
    </div>
  );
}
