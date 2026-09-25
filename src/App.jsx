import { Routes, Route } from 'react-router-dom'
import AppShell from './layout/AppShell.jsx'
import GeneralAI from './pages/GeneralAI.jsx'
import Projects from './pages/Projects.jsx'
import Mentors from './pages/Mentors.jsx'
import Library from './pages/Library.jsx'
import History from './pages/History.jsx'
import Memory from './pages/Memory.jsx'
import Profile from './pages/Profile.jsx'
import Settings from './pages/Settings.jsx'

export default function App() {
  return (
    <AppShell>
      <Routes>
        <Route path="/" element={<GeneralAI />} />
        <Route path="/projects" element={<Projects />} />
        <Route path="/mentors" element={<Mentors />} />
        <Route path="/library" element={<Library />} />
        <Route path="/history" element={<History />} />
        <Route path="/memory" element={<Memory />} />
        <Route path="/profile" element={<Profile />} />
        <Route path="/settings" element={<Settings />} />
      </Routes>
    </AppShell>
  )
}
