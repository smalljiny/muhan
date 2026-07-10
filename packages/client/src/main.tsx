import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'

import { App } from './App'

// 앱 엔트리 — #app에 React 루트를 마운트한다.
const container = document.querySelector<HTMLDivElement>('#app')
if (container) {
  createRoot(container).render(
    <StrictMode>
      <App />
    </StrictMode>,
  )
}
