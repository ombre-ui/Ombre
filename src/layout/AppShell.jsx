import { useEffect, useRef, useState } from 'react'
import Sidebar from './Sidebar.jsx'
import { useUserState } from '../lib/user/UserStateProvider.jsx'
import './AppShell.css'
import './PreviewNotice.css'

function useIsMobile(breakpoint = 767) {
  const [isMobile, setIsMobile] = useState(
    typeof window !== 'undefined' ? window.innerWidth <= breakpoint : false
  )
  useEffect(() => {
    const mq = window.matchMedia(`(max-width: ${breakpoint}px)`)
    const handler = (e) => setIsMobile(e.matches)
    mq.addEventListener('change', handler)
    return () => mq.removeEventListener('change', handler)
  }, [breakpoint])
  return isMobile
}

export default function AppShell({ children }) {
  const isMobile = useIsMobile()
  // Theme is a server-owned setting (src/lib/user/UserStateProvider.jsx); the sidebar toggle and the
  // Settings page both read and change that same value.
  const { theme, toggleTheme } = useUserState()
  const [themeError, setThemeError] = useState(false)
  const themeErrorTimer = useRef(null)

  async function handleToggleTheme() {
    const result = await toggleTheme()
    if (!result.ok) {
      setThemeError(true)
      window.clearTimeout(themeErrorTimer.current)
      themeErrorTimer.current = window.setTimeout(() => setThemeError(false), 2400)
    }
  }
  useEffect(() => () => window.clearTimeout(themeErrorTimer.current), [])

  const [collapsed, setCollapsed] = useState(() => {
    const stored = window.localStorage.getItem('ombre-sidebar-collapsed')
    if (stored !== null) return stored === 'true'
    return window.innerWidth < 1024
  })
  const [mobileOpen, setMobileOpen] = useState(false)

  useEffect(() => {
    window.localStorage.setItem('ombre-sidebar-collapsed', String(collapsed))
  }, [collapsed])

  useEffect(() => {
    if (!isMobile) setMobileOpen(false)
  }, [isMobile])

  useEffect(() => {
    function onKey(e) {
      if (e.key === 'Escape') setMobileOpen(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  // Prevent the page behind the drawer from scrolling while it's open.
  useEffect(() => {
    if (isMobile && mobileOpen) {
      const previous = document.body.style.overflow
      document.body.style.overflow = 'hidden'
      return () => {
        document.body.style.overflow = previous
      }
    }
  }, [isMobile, mobileOpen])

  const handleToggle = () => {
    if (isMobile) setMobileOpen((v) => !v)
    else setCollapsed((v) => !v)
  }

  return (
    <div className="app-shell">
      <Sidebar
        collapsed={!isMobile && collapsed}
        onToggle={handleToggle}
        mobileOpen={isMobile && mobileOpen}
        onCloseMobile={() => setMobileOpen(false)}
        isMobile={isMobile}
        theme={theme.resolved}
        onToggleTheme={handleToggleTheme}
        themeDisabled={!theme.ready}
      />
      <div className="app-shell-main">
        {isMobile && (
          <header className="app-topbar">
            <button
              className="app-topbar-toggle motion-interactive"
              onClick={handleToggle}
              aria-label="Open navigation"
              aria-expanded={mobileOpen}
            >
              <span className="topbar-bar" />
              <span className="topbar-bar" />
              <span className="topbar-bar" />
            </button>
            <span className="text-wordmark app-topbar-wordmark">ombre</span>
          </header>
        )}
        <main className="app-workspace">{children}</main>
      </div>
      {themeError && (
        <div className="shell-toast motion-reveal" role="status">
          Couldn’t save your theme. It wasn’t changed.
        </div>
      )}
    </div>
  )
}
