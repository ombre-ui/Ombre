import { NavLink } from 'react-router-dom'
import {
  Menu,
  Sparkles,
  FolderKanban,
  Compass,
  Library as LibraryIcon,
  History as HistoryIcon,
  CircleDot,
  CircleUserRound,
  Settings as SettingsIcon,
  Sun,
  Moon,
} from 'lucide-react'
import './Sidebar.css'

const NAV_ITEMS = [
  { to: '/', label: 'General AI', icon: Sparkles, end: true },
  { to: '/projects', label: 'Projects', icon: FolderKanban },
  { to: '/mentors', label: 'Mentors', icon: Compass },
  { to: '/library', label: 'Library', icon: LibraryIcon },
  { to: '/history', label: 'History', icon: HistoryIcon },
  { to: '/memory', label: 'Memory', icon: CircleDot },
]

const FOOTER_ITEMS = [
  { to: '/profile', label: 'Profile', icon: CircleUserRound },
  { to: '/settings', label: 'Settings', icon: SettingsIcon },
]

export default function Sidebar({
  collapsed,
  onToggle,
  mobileOpen,
  onCloseMobile,
  isMobile,
  theme,
  onToggleTheme,
}) {
  return (
    <>
      {mobileOpen && (
        <div className="sidebar-scrim motion-reveal" onClick={onCloseMobile} aria-hidden="true" />
      )}
      <aside
        className={`sidebar ${collapsed ? 'is-collapsed' : ''} ${
          mobileOpen ? 'is-mobile-open' : ''
        }`}
        aria-label="Primary"
      >
        <div className="sidebar-top">
          {/* On mobile the topbar hamburger already opens/closes this drawer —
              don't duplicate that control inside the drawer itself. */}
          {!isMobile && (
            <button
              className="sidebar-toggle motion-interactive"
              onClick={onToggle}
              aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
              aria-expanded={!collapsed}
            >
              <Menu size={18} strokeWidth={1.75} />
            </button>
          )}
          {!collapsed && <span className="sidebar-wordmark text-wordmark">ombre</span>}
        </div>

        <nav className="sidebar-nav">
          <ul>
            {NAV_ITEMS.map(({ to, label, icon: Icon, end }) => (
              <li key={to}>
                <NavLink
                  to={to}
                  end={end}
                  className={({ isActive }) =>
                    `sidebar-link motion-interactive ${isActive ? 'is-active' : ''}`
                  }
                  onClick={onCloseMobile}
                  title={collapsed ? label : undefined}
                >
                  <Icon size={18} strokeWidth={1.75} aria-hidden="true" />
                  {!collapsed && <span>{label}</span>}
                </NavLink>
              </li>
            ))}
          </ul>
        </nav>

        <div className="sidebar-footer">
          <ul>
            <li>
              <button
                className="sidebar-link motion-interactive"
                onClick={onToggleTheme}
                title={collapsed ? (theme === 'dark' ? 'Light mode' : 'Dark mode') : undefined}
                aria-label={theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'}
              >
                {theme === 'dark' ? (
                  <Sun size={18} strokeWidth={1.75} aria-hidden="true" />
                ) : (
                  <Moon size={18} strokeWidth={1.75} aria-hidden="true" />
                )}
                {!collapsed && <span>{theme === 'dark' ? 'Light mode' : 'Dark mode'}</span>}
              </button>
            </li>
            {FOOTER_ITEMS.map(({ to, label, icon: Icon }) => (
              <li key={to}>
                <NavLink
                  to={to}
                  className={({ isActive }) =>
                    `sidebar-link motion-interactive ${isActive ? 'is-active' : ''}`
                  }
                  onClick={onCloseMobile}
                  title={collapsed ? label : undefined}
                >
                  <Icon size={18} strokeWidth={1.75} aria-hidden="true" />
                  {!collapsed && <span>{label}</span>}
                </NavLink>
              </li>
            ))}
          </ul>
        </div>
      </aside>
    </>
  )
}
