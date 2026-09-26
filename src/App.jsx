import { Routes, Route, Navigate } from 'react-router-dom'
import AppShell from './layout/AppShell.jsx'
import { OmbreDataProvider } from './lib/store.jsx'
import GeneralAIPage from './features/general-ai/GeneralAIPage.jsx'
import ProjectsOverviewPage from './features/projects/ProjectsOverviewPage.jsx'
import ProjectWorkspacePage from './features/projects/ProjectWorkspacePage.jsx'
import Mentors from './pages/Mentors.jsx'
import Library from './pages/Library.jsx'
import History from './pages/History.jsx'
import Memory from './pages/Memory.jsx'
import Profile from './pages/Profile.jsx'
import Settings from './pages/Settings.jsx'

export default function App() {
  return (
    <OmbreDataProvider>
      <AppShell>
        <Routes>
          <Route path="/" element={<Navigate to="/app/general" replace />} />

          <Route path="/app/general" element={<GeneralAIPage />} />
          <Route path="/app/general/:conversationId" element={<GeneralAIPage />} />

          <Route path="/app/projects" element={<ProjectsOverviewPage />} />
          <Route path="/app/projects/:projectId" element={<ProjectWorkspacePage />} />

          <Route path="/app/mentors" element={<Mentors />} />
          <Route path="/app/library" element={<Library />} />
          <Route path="/app/history" element={<History />} />
          <Route path="/app/memory" element={<Memory />} />
          <Route path="/app/profile" element={<Profile />} />
          <Route path="/app/settings" element={<Settings />} />

          <Route path="*" element={<Navigate to="/app/general" replace />} />
        </Routes>
      </AppShell>
    </OmbreDataProvider>
  )
}
