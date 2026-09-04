import { BrowserRouter, Navigate, Route, Routes } from "react-router-dom";
import { AdminPage } from "./admin/AdminPage";
import { AuthProvider } from "./auth/AuthContext";
import { LoginPage } from "./auth/LoginPage";
import { PasswordPage } from "./auth/PasswordPage";
import { RequireAdmin, RequireAuth } from "./auth/RequireAuth";
import { ErrorNotice } from "./components/ErrorNotice";
import { SessionListPage } from "./sessions/SessionListPage";
import { SessionPage } from "./sessions/SessionPage";

export function App() {
  return (
    <BrowserRouter>
      <AuthProvider>
        <Routes>
          <Route path="/login" element={<LoginPage />} />

          <Route element={<RequireAuth allowPasswordChange />}>
            <Route path="/password" element={<PasswordPage />} />
          </Route>

          <Route element={<RequireAuth />}>
            <Route path="/" element={<SessionListPage />} />
            <Route element={<RequireAdmin />}>
              <Route path="/admin" element={<AdminPage />} />
            </Route>
            <Route path="/s/:sessionId" element={<SessionPage />} />
            <Route path="/s/:sessionId/p/:pageId" element={<SessionPage />} />
          </Route>

          <Route
            path="*"
            element={<ErrorNotice title="페이지를 찾을 수 없습니다" message="주소를 다시 확인해 주세요." />}
          />
          <Route path="/index.html" element={<Navigate to="/" replace />} />
        </Routes>
      </AuthProvider>
    </BrowserRouter>
  );
}
