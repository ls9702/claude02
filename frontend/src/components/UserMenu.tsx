import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useAuth } from "../auth/AuthContext";

export function UserMenu() {
  const { user, logout } = useAuth();
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDocClick = (event: MouseEvent) => {
      if (ref.current && !ref.current.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDocClick);
    return () => document.removeEventListener("mousedown", onDocClick);
  }, [open]);

  if (!user) return null;

  return (
    <div className="user-menu" ref={ref}>
      <button
        type="button"
        className="button ghost"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        data-testid="user-menu-button"
      >
        {user.username} ▾
      </button>
      {open ? (
        <div className="menu" role="menu">
          {user.role === "admin" ? (
            <button type="button" role="menuitem" onClick={() => navigate("/admin")}>
              관리자
            </button>
          ) : null}
          <button type="button" role="menuitem" onClick={() => navigate("/password")}>
            비밀번호 변경
          </button>
          <button
            type="button"
            role="menuitem"
            data-testid="logout-button"
            onClick={async () => {
              await logout();
              navigate("/login", { replace: true });
            }}
          >
            로그아웃
          </button>
        </div>
      ) : null}
    </div>
  );
}
