import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App'
// tldraw's own stylesheet MUST load first — theme.css overrides it below.
import 'tldraw/tldraw.css'
import './lib/theme.css'

const root = document.getElementById('root')
if (!root) throw new Error('no #root element')

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>
)