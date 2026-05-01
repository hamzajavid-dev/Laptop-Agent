import { useMemo } from 'react'
import MainLayout from './components/MainLayout'
import Overlay from './components/Overlay'

export default function App() {
  const isOverlay = useMemo(
    () => new URLSearchParams(window.location.search).get('mode') === 'overlay',
    []
  )

  return isOverlay ? <Overlay /> : <MainLayout />
}
