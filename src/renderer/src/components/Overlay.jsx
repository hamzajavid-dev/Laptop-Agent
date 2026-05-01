import { useState, useEffect, useRef } from 'react'
import { Crosshair } from 'lucide-react'

export default function Overlay() {
  const [active, setActive] = useState(false)
  const rootRef = useRef(null)

  // Make the body transparent so the Electron transparent window works
  useEffect(() => {
    document.body.style.background = 'transparent'
    return () => { document.body.style.background = '' }
  }, [])

  // Listen for activation signal from main process
  useEffect(() => {
    const cleanup = window.api.onOverlayActivate(() => {
      setActive(true)
      // Focus the container so keyboard events fire
      setTimeout(() => rootRef.current?.focus(), 50)
    })
    return cleanup
  }, [])

  const handleClick = (e) => {
    if (!active) return
    setActive(false)
    // screenX/screenY give absolute screen coordinates regardless of window position
    window.api.submitCapture({ x: e.screenX, y: e.screenY })
  }

  const handleKeyDown = (e) => {
    if (e.key === 'Escape' && active) {
      setActive(false)
      window.api.cancelCapture()
    }
  }

  return (
    <div
      ref={rootRef}
      tabIndex={0}
      className="fixed inset-0 outline-none"
      style={{
        backgroundColor: active ? 'rgba(59, 130, 246, 0.18)' : 'transparent',
        cursor: active ? 'crosshair' : 'default',
        transition: 'background-color 0.15s ease'
      }}
      onClick={handleClick}
      onKeyDown={handleKeyDown}
    >
      {active && (
        <div className="absolute top-4 left-1/2 -translate-x-1/2 pointer-events-none">
          <div className="bg-slate-900/90 backdrop-blur border border-blue-500/30 rounded-xl px-6 py-3 flex items-center gap-3 shadow-xl shadow-black/40">
            <div className="w-7 h-7 rounded-full bg-blue-500/20 border border-blue-500/40 flex items-center justify-center shrink-0">
              <Crosshair size={14} className="text-blue-400" />
            </div>
            <div>
              <span className="text-white text-sm font-medium">Click to capture coordinate</span>
              <span className="text-slate-500 text-xs ml-3">
                <kbd className="bg-slate-800 border border-slate-700 rounded px-1 py-0.5 text-slate-400 font-mono text-xs">Esc</kbd> to cancel
              </span>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
