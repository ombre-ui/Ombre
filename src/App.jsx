import { Routes, Route, Navigate, Outlet } from 'react-router-dom'
import AppShell from './layout/AppShell.jsx'
import { OmbreDataProvider } from './lib/store.jsx'
import { AuthProvider } from './lib/auth/AuthProvider.jsx'
import { RequireAuth, PublicOnly } from './lib/auth/guards.jsx'
import LoginPage from './features/auth/LoginPage.jsx'
import SignupPage from './features/auth/SignupPage.jsx'
import ForgotPasswordPage from './features/auth/ForgotPasswordPage.jsx'
import AuthCallbackPage from './features/auth/AuthCallbackPage.jsx'
import ResetPasswordPage from './features/auth/ResetPasswordPage.jsx'
import GeneralAIPage from './features/general-ai/GeneralAIPage.jsx'
import ProjectsOverviewPage from './features/projects/ProjectsOverviewPage.jsx'
import ProjectWorkspacePage from './features/projects/ProjectWorkspacePage.jsx'
import MentorsPage from './features/mentors/MentorsPage.jsx'
import MentorCategoryPage from './features/mentors/MentorCategoryPage.jsx'
import MentorSubcategoryPage from './features/mentors/MentorSubcategoryPage.jsx'
import MentorProfilePage from './features/mentors/MentorProfilePage.jsx'
import LibraryPage from './features/library/LibraryPage.jsx'
import HistoryPage from './features/history/HistoryPage.jsx'
import MemoryPage from './features/memory/MemoryPage.jsx'
import ProfilePage from './features/profile/ProfilePage.jsx'
import SettingsPage from './features/settings/SettingsPage.jsx'

function ShellLayout() {
  return (
    <AppShell>
      <Outlet />
    </AppShell>
  )
}

export default function App() {
  return (
    <AuthProvider>
      <OmbreDataProvider>
        <Routes>
          <Route element={<PublicOnly />}>
            <Route path="/login" element={<LoginPage />} />
            <Route path="/signup" element={<SignupPage />} />
            <Route path="/forgot-password" element={<ForgotPasswordPage />} />
          </Route>

          <Route path="/auth/callback" element={<AuthCallbackPage />} />
          <Route path="/auth/callback/recovery" element={<AuthCallbackPage purpose="recovery" />} />

          <Route element={<RequireAuth />}>
            <Route path="/reset-password" element={<ResetPasswordPage />} />

            <Route element={<ShellLayout />}>
              <Route path="/" element={<Navigate to="/app/general" replace />} />

              <Route path="/app/general" element={<GeneralAIPage />} />
              <Route path="/app/general/:conversationId" element={<GeneralAIPage />} />

              <Route path="/app/projects" element={<ProjectsOverviewPage />} />
              <Route path="/app/projects/:projectId" element={<ProjectWorkspacePage />} />

              <Route path="/app/mentors" element={<MentorsPage />} />
              <Route path="/app/mentors/:categoryId" element={<MentorCategoryPage />} />
              <Route path="/app/mentors/:categoryId/:subcategoryId" element={<MentorSubcategoryPage />} />
              <Route
                path="/app/mentors/:categoryId/:subcategoryId/:mentorId"
                element={<MentorProfilePage />}
              />

              <Route path="/app/library" element={<LibraryPage />} />
              <Route path="/app/history" element={<HistoryPage />} />
              <Route path="/app/memory" element={<MemoryPage />} />

              <Route path="/app/profile" element={<ProfilePage />} />
              <Route path="/app/settings" element={<SettingsPage />} />

              <Route path="*" element={<Navigate to="/app/general" replace />} />
            </Route>
          </Route>
        </Routes>
      </OmbreDataProvider>
    </AuthProvider>
  )
}
