import { Navigate, Outlet, useLocation } from "react-router-dom";
import { Spinner } from "../components/Spinner";
import { useAuth } from "./AuthContext";

/** 로그인 필수 라우트 가드. 비밀번호 변경 강제 사용자는 /password 로 보낸다. */
export function RequireAuth({ allowPasswordChange = false }: { allowPasswordChange?: boolean }) {
  const { user, loading } = useAuth();
  const location = useLocation();

  if (loading) return <Spinner label="불러오는 중…" />;
  if (!user) return <Navigate to="/login" replace state={{ from: location.pathname }} />;
  if (user.must_change_password && !allowPasswordChange) return <Navigate to="/password" replace />;
  return <Outlet />;
}

/** 관리자 전용 라우트 가드 */
export function RequireAdmin() {
  const { user } = useAuth();
  if (user && user.role !== "admin") {
    return (
      <div className="centered-page">
        <div className="card notice">
          <h1>접근 권한이 없습니다</h1>
          <p>이 화면은 관리자만 사용할 수 있습니다.</p>
        </div>
      </div>
    );
  }
  return <Outlet />;
}
