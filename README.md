# Ombre

An AI intelligence workspace: a General AI, a library of specialized Mentors organized by category, Projects that tie conversations/files/mentors together, History, and Memory — built as one interconnected space rather than a set of separate dashboard pages.

## Status: Phase 1 — Foundation

This commit implements only the foundational layers:

1. **Global design foundation** — the token system (`/design`) applied application-wide: colors (light + dark), typography, motion, spacing/radius/shadow.
2. **Application shell** — the reusable layout (`src/layout/AppShell.jsx`) that every future workspace plugs into: sidebar region, main workspace region, responsive desktop/tablet/mobile behavior.
3. **Sidebar navigation** — the full navigation hierarchy (`src/layout/Sidebar.jsx`) with default/active/hover/focus/collapsed states and mobile off-canvas behavior.

**Not yet built (by design — see scope below):** the actual General AI, Projects, Mentors, Library, History, and Memory workspaces are placeholder pages only. No backend, auth, or database integration yet.

## Getting started

```bash
npm install
npm run dev
```

## Project structure

```
design/              Design tokens — source of truth for color, type, motion
  tokens.css
  typography.css
  motion.css
  README.md          How to use the token system

src/
  layout/
    AppShell.jsx     Viewport structure: sidebar + main workspace, responsive behavior
    Sidebar.jsx       Navigation: General AI, Projects, Mentors, Library, History, Memory, Profile, Settings
    PageContainer.jsx Shared page header/content wrapper every workspace page uses
  pages/             One placeholder file per workspace — real functionality comes in later phases
  App.jsx            Route definitions
  main.jsx           Entry point; imports the design tokens globally
```

## Design principles this build follows

- **Sidebar navigates, the main canvas explores.** The sidebar never lists every conversation, project, or mentor — it links to the six top-level areas plus Profile/Settings, nothing else.
- **No hardcoded visual values.** Every color, spacing value, radius, shadow, and animation duration in the shell and sidebar comes from `/design` tokens. If a component seems to need a new value, add it as a token first.
- **Motion animates relationships, not pages.** The shell uses `motion-reveal` for content entering view and `motion-interactive` for hover/focus states — see `/design/motion.css` for the full language (Reveal, Drift, Expand, Connect, Focus, Return, Settle).
- **Same brand, different distribution.** The palette is identical to the marketing site; the product uses it for hierarchy and restraint rather than cinematic drama.

## Known follow-ups / unresolved decisions

- Mobile sidebar overlay closes on Escape and backdrop click, but does not yet trap focus — worth adding with a proper dialog pattern once a11y testing starts.
- No icon set decision beyond Lucide (minimal line-style, matches brand intent) — revisit if `ui/ux-pro-max` surfaces a stronger fit.
- Theme toggle persists to `localStorage` and defaults to system preference; no server-side user preference sync yet (depends on auth/DB, out of scope for this phase).
- Tablet breakpoint (768–1023px) defaults the sidebar to collapsed on first load; confirm this is the desired default once real content is in the workspaces.
