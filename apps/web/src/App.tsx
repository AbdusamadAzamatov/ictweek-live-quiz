import { BrowserRouter, Navigate, Route, Routes } from 'react-router';
import { JoinPage } from './pages/JoinPage';
import { JoinNicknamePage } from './pages/JoinNicknamePage';
import { LoginPage } from './pages/admin/LoginPage';
import { LibraryPage } from './pages/admin/LibraryPage';
import { QuizViewPage } from './pages/admin/QuizViewPage';
import { HostStubPage } from './pages/admin/HostStubPage';
import { DiagnosticsPage } from './pages/admin/DiagnosticsPage';
import { RequireAuth } from './components/RequireAuth';
import { AdminLayout } from './components/AdminLayout';

function Admin({ children }: { children: React.ReactNode }) {
  return (
    <RequireAuth>
      <AdminLayout>{children}</AdminLayout>
    </RequireAuth>
  );
}

export function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<JoinPage />} />
        <Route path="/join/:pin" element={<JoinNicknamePage />} />
        <Route path="/admin/login" element={<LoginPage />} />
        <Route
          path="/admin"
          element={
            <Admin>
              <LibraryPage />
            </Admin>
          }
        />
        <Route
          path="/admin/quizzes/:id"
          element={
            <Admin>
              <QuizViewPage />
            </Admin>
          }
        />
        <Route
          path="/admin/host/:id"
          element={
            <Admin>
              <HostStubPage />
            </Admin>
          }
        />
        <Route
          path="/admin/diagnostics"
          element={
            <Admin>
              <DiagnosticsPage />
            </Admin>
          }
        />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </BrowserRouter>
  );
}
