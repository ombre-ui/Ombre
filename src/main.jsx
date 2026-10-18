import React from 'react'
import ReactDOM from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import App from './App.jsx'
import { initTheme } from './lib/theme.js'
import { purgeLegacyLocalData } from './lib/auth/localData.js'
import '../design/tokens.css'
import '../design/typography.css'
import '../design/motion.css'
import './App.css'

// Before first render, with no network or auth: apply the last server-confirmed theme preference (a validated
// cache, corrected once the real setting loads) and remove demo data older builds left in localStorage.
initTheme()
purgeLegacyLocalData()

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <BrowserRouter>
      <App />
    </BrowserRouter>
  </React.StrictMode>,
)
