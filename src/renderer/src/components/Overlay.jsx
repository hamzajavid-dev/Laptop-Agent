import { useState, useEffect, useRef, useCallback } from 'react'
import { Crosshair, RectangleHorizontal } from 'lucide-react'

export default function Overlay() {
  const [mode, setMode] = useState(null) // null | 'point' | 'region'
  const rootRef = useRef(null)

  // drag state for region mode
  const dragStart = useRef(null)
  const [dragRect, setDragRect] = useState(null) // { x, y, w, h } in CSS px for display

  useEffect(() => {
    document.body.style.background = 'transparent'
    return () => { document.body.style.background = '' }
  }, [])

  useEffect(() => {
    const cleanups = [
      window.api.onOverlayActivate(() => {
        setMode('point')
        setDragRect(null)
        dragStart.current = null
        setTimeout(() => rootRef.current?.focus(), 50)
      }),
      window.api.onOverlayActivateRegion(() => {
        setMode('region')
        setDragRect(null)
        dragStart.current = null
        setTimeout(() => rootRef.current?.focus(), 50)
      })
    ]
    return () => cleanups.forEach(fn => fn())
  }, [])

  // ── Point mode ───────────────────────────────────────────────────────────────
  const handleClick = (e) => {
    if (mode !== 'point') return
    setMode(null)
    window.api.submitCapture({ x: e.screenX, y: e.screenY })
  }

  // ── Region mode ──────────────────────────────────────────────────────────────
  const handleMouseDown = useCallback((e) => {
    if (mode !== 'region') return
    dragStart.current = { x: e.clientX, y: e.clientY, sx: e.screenX, sy: e.screenY }
    setDragRect({ x: e.clientX, y: e.clientY, w: 0, h: 0 })
  }, [mode])

  const handleMouseMove = useCallback((e) => {
    if (mode !== 'region' || !dragStart.current) return
    const x = Math.min(e.clientX, dragStart.current.x)
    const y = Math.min(e.clientY, dragStart.current.y)
    const w = Math.abs(e.clientX - dragStart.current.x)
    const h = Math.abs(e.clientY - dragStart.current.y)
    setDragRect({ x, y, w, h })
  }, [mode])

  const handleMouseUp = useCallback((e) => {
    if (mode !== 'region' || !dragStart.current) return
    const sx = Math.min(e.screenX, dragStart.current.sx)
    const sy = Math.min(e.screenY, dragStart.current.sy)
    const sw = Math.abs(e.screenX - dragStart.current.sx)
    const sh = Math.abs(e.screenY - dragStart.current.sy)
    dragStart.current = null
    setDragRect(null)
    setMode(null)
    if (sw < 4 || sh < 4) {
      // Too small — cancel
      window.api.cancelRegionCapture()
      return
    }
    window.api.submitRegionCapture({ x: sx, y: sy, width: sw, height: sh })
  }, [mode])

  // ── Keyboard ─────────────────────────────────────────────────────────────────
  const handleKeyDown = (e) => {
    if (e.key === 'Escape' && mode) {
      setMode(null)
      setDragRect(null)
      dragStart.current = null
      if (mode === 'region') window.api.cancelRegionCapture()
      else window.api.cancelCapture()
    }
  }

  const active = mode !== null

  return (
    <div
      ref={rootRef}
      tabIndex={0}
      className="fixed inset-0 outline-none select-none"
      style={{
        backgroundColor: active ? 'rgba(59, 130, 246, 0.12)' : 'transparent',
        cursor: mode === 'region' ? 'crosshair' : mode === 'point' ? 'crosshair' : 'default',
        transition: 'background-color 0.15s ease'
      }}
      onClick={handleClick}
      onMouseDown={handleMouseDown}
      onMouseMove={handleMouseMove}
      onMouseUp={handleMouseUp}
      onKeyDown={handleKeyDown}
    >
      {/* Instruction banner */}
      {active && (
        <div className="absolute top-4 left-1/2 -translate-x-1/2 pointer-events-none z-10">
          <div className="bg-slate-900/90 backdrop-blur border border-blue-500/30 rounded-xl px-6 py-3 flex items-center gap-3 shadow-xl shadow-black/40">
            <div className="w-7 h-7 rounded-full bg-blue-500/20 border border-blue-500/40 flex items-center justify-center shrink-0">
              {mode === 'region'
                ? <RectangleHorizontal size={14} className="text-blue-400" />
                : <Crosshair size={14} className="text-blue-400" />
              }
            </div>
            <div>
              <span className="text-white text-sm font-medium">
                {mode === 'region' ? 'Click and drag to select a region' : 'Click to capture coordinate'}
              </span>
              <span className="text-slate-500 text-xs ml-3">
                <kbd className="bg-slate-800 border border-slate-700 rounded px-1 py-0.5 text-slate-400 font-mono text-xs">Esc</kbd> to cancel
              </span>
            </div>
          </div>
        </div>
      )}

      {/* Drag rectangle preview */}
      {mode === 'region' && dragRect && dragRect.w > 0 && (
        <div
          className="absolute border-2 border-blue-400 bg-blue-400/10 pointer-events-none"
          style={{
            left: dragRect.x,
            top: dragRect.y,
            width: dragRect.w,
            height: dragRect.h
          }}
        />
      )}
    </div>
  )
}
