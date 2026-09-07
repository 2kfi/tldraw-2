import { useEffect, useState } from 'react'
import { Home } from './home/Home'
import { Room } from './room/Room'

export function App() {
  const [hash, setHash] = useState(() => window.location.hash)

  // Create/Join write window.location.hash; without this listener the URL
  // changes but React never re-renders, so the room never opens.
  useEffect(() => {
    const onHash = () => setHash(window.location.hash)
    window.addEventListener('hashchange', onHash)
    return () => window.removeEventListener('hashchange', onHash)
  }, [])

  const route = hash.replace(/^#/, '') || '/'

  return (
    <>
      <a className="skip-link" href="#main-content">
        Skip to content
      </a>
      {route.startsWith('/r/') && route.slice(3) ? <Room roomId={route.slice(3)} /> : <Home />}
    </>
  )
}