import { BrowserRouter, Navigate, Route, Routes } from 'react-router';
import { JoinPage } from './pages/JoinPage';
import { JoinNicknamePage } from './pages/JoinNicknamePage';
import { PlayPage } from './pages/PlayPage';
import { DisplayPage } from './pages/DisplayPage';
import { LoginPage } from './pages/admin/LoginPage';
import { LibraryPage } from './pages/admin/LibraryPage';
import { QuizEditorPage } from './pages/admin/QuizEditorPage';
import { QuizPreviewPage } from './pages/admin/QuizPreviewPage';
import { SessionNewPage } from './pages/admin/SessionNewPage';
import { HostPage } from './pages/admin/HostPage';
import { SessionReportPage } from './pages/admin/SessionReportPage';
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
        <Route path="/play" element={<PlayPage />} />
        <Route path="/display/:displayKey" element={<DisplayPage />} />
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
              <QuizEditorPage />
            </Admin>
          }
        />
        <Route
          path="/admin/quizzes/:id/preview"
          element={
            <Admin>
              <QuizPreviewPage />
            </Admin>
          }
        />
        <Route
          path="/admin/sessions/new"
          element={
            <Admin>
              <SessionNewPage />
            </Admin>
          }
        />
        <Route
          path="/admin/host/:id"
          element={
            <Admin>
              <HostPage />
            </Admin>
          }
        />
        <Route
          path="/admin/sessions/:id/report"
          element={
            <Admin>
              <SessionReportPage />
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
