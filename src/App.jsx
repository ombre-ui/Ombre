import { Routes, Route, Navigate } from 'react-router-dom'
import AppShell from './layout/AppShell.jsx'
import { OmbreDataProvider } from './lib/store.jsx'
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

          <Route path="/app/profile" element={<Profile />} />
          <Route path="/app/settings" element={<Settings />} />

          <Route path="*" element={<Navigate to="/app/general" replace />} />
        </Routes>
      </AppShell>
    </OmbreDataProvider>
  )
}
