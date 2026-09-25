# Ombre — Design System Foundation

This is the design-token layer for the Ombre product. Build every screen against these files — never hardcode a hex value, spacing number, or animation duration directly in a component.

## Files

```
design/
  tokens.css       Colors (light + dark), spacing, radius, shadows
  typography.css   Fonts, type scale, text utility classes
  motion.css       The Ombre motion language (Reveal, Drift, Expand,
                    Connect, Focus, Return, Settle) + reduced-motion support
```

## Usage

Imported once, globally, in `src/main.jsx`. Components reference variables and utility classes only:

```css
.sidebar {
  background: var(--surface);
  color: var(--text-primary);
  border-right: 1px solid var(--border);
}
```

## Dark mode

Toggle by setting `data-theme="dark"` on `<html>`. Every semantic token is redefined for dark mode inside `tokens.css` — light and dark are each purpose-built, not one inverted from the other. See `src/layout/AppShell.jsx` for the toggle implementation.

## Section temperature (instead of a teal/violet system)

General AI and Projects use the default neutral tokens. Mentors and Memory get a warmer lean by wrapping that section in `.section-warm`, which shifts `--surface`, `--surface-elevated`, and `--accent` toward sand/amber without introducing a new hue.

## Standing rule for AI coding builders

> Do not introduce new colors, spacing values, or animation durations. Use only the variables and utility classes defined in `design/tokens.css`, `design/typography.css`, and `design/motion.css`. If a new value seems necessary, add it as a token first, then reference it — never hardcode inline.

## Reference palette

| Role | Hex | Token |
|---|---|---|
| Bone | `#F4ECDF` | `--ombre-bone` |
| Sand | `#E3D2B6` | `--ombre-sand` |
| Amber | `#D29A4B` | `--ombre-amber` |
| Sienna | `#A8532E` | `--ombre-sienna` |
| Cognac | `#4A2C1F` | `--ombre-cognac` |
| Taupe | `#8C7B6B` | `--ombre-taupe` |
| Aubergine | `#2A1A26` | `--ombre-aubergine` |
| Sidebar (derived) | `#EEE3D3` | `--ombre-sidebar` |

Same palette as the landing page. The landing page uses it for atmosphere and drama; the product uses it for hierarchy and restraint.
