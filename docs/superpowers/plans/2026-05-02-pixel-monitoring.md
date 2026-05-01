# Pixel Monitoring Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add pixel-color-based VICIdial call status detection to the Electron agent, syncing detected status (live_call / hung_up / idle) to Supabase in real time so the web dashboard shows a live call status badge.

**Architecture:** A new `pixelMonitor.js` main-process module polls a user-selected screen region using Electron's `desktopCapturer`, compares average RGB against three calibrated colors, debounces readings, and upserts `agent_status` in Supabase on confirmed state changes. The overlay window gains a drag-to-draw region-select mode reusing the existing transparent overlay pattern. The web app adds a `CallStatusBadge` component subscribed to Supabase Realtime on the `agent_status` table.

**Tech Stack:** Electron 31 (desktopCapturer, NativeImage), electron-store, Supabase JS v2, React 18, Next.js 14, Tailwind CSS, lucide-react

---

## File Map

### Laptop Agent (`feature/pixel-monitoring` branch)

| Action | File | Purpose |
|--------|------|---------|
| **Create** | `src/main/pixelMonitor.js` | Core monitor: capture loop, RGB compare, debounce, emit |
| **Modify** | `src/main/index.js` | Integrate pixelMonitor, add IPC handlers, Supabase agent_status upsert |
| **Modify** | `src/preload/index.js` | Expose new IPC channels to renderer |
| **Modify** | `src/renderer/src/components/Overlay.jsx` | Add region-select drag mode alongside existing click mode |
| **Modify** | `src/renderer/src/components/Settings.jsx` | Add Pixel Monitoring section (toggle, interval, calibrate, region) |
| **Modify** | `src/renderer/src/components/TitleBar.jsx` | Add call status badge |
| **Modify** | `src/renderer/src/components/MainLayout.jsx` | Wire pixelMonitor IPC events, pass callStatus to TitleBar |
| **Modify** | `schema.sql` | Add agent_status table + realtime |

### Web App (new `feature/pixel-monitoring` branch)

| Action | File | Purpose |
|--------|------|---------|
| **Modify** | `src/lib/types.ts` | Add AgentStatus type |
| **Create** | `src/components/CallStatusBadge.tsx` | Realtime status pill component |
| **Modify** | `src/components/Dashboard.tsx` | Mount CallStatusBadge in header |

---

## Task 1: Supabase Schema — agent_status table

**Files:**
- Modify: `Laptop Agent/schema.sql`

- [ ] **Step 1: Add agent_status table to schema.sql**

Append to the bottom of `schema.sql`:

```sql
-- Agent call status (pixel monitoring)
create table if not exists public.agent_status (
  id         uuid primary key default gen_random_uuid(),
  agent_id   text not null unique,
  status     text not null default 'idle',  -- 'live_call' | 'hung_up' | 'idle'
  updated_at timestamptz not null default now()
);

alter table public.agent_status enable row level security;
drop policy if exists "allow_all" on public.agent_status;
create policy "allow_all" on public.agent_status for all using (true) with check (true);

-- Enable Realtime for agent_status
do $$
begin
    if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and tablename = 'agent_status') then
        alter publication supabase_realtime add table public.agent_status;
    end if;
end $$;
```

- [ ] **Step 2: Run in Supabase SQL Editor**

Open your Supabase project → SQL Editor → paste and run the above block.

Verify: Table `agent_status` appears in Table Editor with columns `id`, `agent_id`, `status`, `updated_at`.

- [ ] **Step 3: Commit schema change**

```bash
cd "Laptop Agent"
git add schema.sql
git commit -m "feat: add agent_status table to schema"
```

---

## Task 2: pixelMonitor.js — Core Module

**Files:**
- Create: `Laptop Agent/src/main/pixelMonitor.js`

- [ ] **Step 1: Create the file with capture + color logic**

```js
const { desktopCapturer, screen } = require('electron')

// ── State ─────────────────────────────────────────────────────────────────────
let _timer = null
let _lastConfirmed = null
let _readings = []
let _onStatusChange = null
let _config = null

// ── Public API ────────────────────────────────────────────────────────────────
function start(config, onStatusChange) {
  stop()
  _config = config
  _onStatusChange = onStatusChange
  _readings = []
  _lastConfirmed = null
  _tick()
  _timer = setInterval(_tick, config.intervalMs)
}

function stop() {
  if (_timer) { clearInterval(_timer); _timer = null }
  _readings = []
  _lastConfirmed = null
}

async function sampleRegion(region) {
  const avg = await _captureRegionAvgColor(region)
  return avg
}

module.exports = { start, stop, sampleRegion }

// ── Internal ──────────────────────────────────────────────────────────────────
let _ticking = false

async function _tick() {
  if (_ticking || !_config) return
  _ticking = true
  try {
    const avg = await _captureRegionAvgColor(_config.region)
    if (!avg) return

    const detected = _classify(avg, _config.calibration, _config.tolerance)

    _readings.push(detected)
    if (_readings.length > _config.debounceCount) _readings.shift()

    if (
      _readings.length === _config.debounceCount &&
      _readings.every(r => r === _readings[0]) &&
      _readings[0] !== _lastConfirmed
    ) {
      _lastConfirmed = _readings[0]
      if (_onStatusChange) _onStatusChange(_readings[0])
    }
  } catch (e) {
    console.warn('[PixelMonitor] tick error:', e.message)
  } finally {
    _ticking = false
  }
}

async function _captureRegionAvgColor(region) {
  const display = screen.getPrimaryDisplay()
  const { width, height } = display.size

  const sources = await desktopCapturer.getSources({
    types: ['screen'],
    thumbnailSize: { width, height }
  })

  if (!sources.length) return null

  const thumb = sources[0].thumbnail
  const cropped = thumb.crop({
    x: Math.round(region.x),
    y: Math.round(region.y),
    width: Math.max(1, Math.round(region.width)),
    height: Math.max(1, Math.round(region.height))
  })

  const bitmap = cropped.toBitmap() // raw RGBA Buffer
  if (!bitmap.length) return null

  let r = 0, g = 0, b = 0
  const pixelCount = bitmap.length / 4
  for (let i = 0; i < bitmap.length; i += 4) {
    r += bitmap[i]
    g += bitmap[i + 1]
    b += bitmap[i + 2]
  }
  return {
    r: Math.round(r / pixelCount),
    g: Math.round(g / pixelCount),
    b: Math.round(b / pixelCount)
  }
}

function _colorDistance(a, b) {
  return Math.sqrt((a.r - b.r) ** 2 + (a.g - b.g) ** 2 + (a.b - b.b) ** 2)
}

function _classify(avg, calibration, tolerance) {
  const states = ['live_call', 'hung_up', 'idle']
  let best = null
  let bestDist = Infinity

  for (const state of states) {
    const cal = calibration[state]
    if (!cal) continue
    const dist = _colorDistance(avg, cal)
    if (dist < bestDist) { bestDist = dist; best = state }
  }

  if (best === null || bestDist > tolerance) return 'idle'
  return best
}
```

- [ ] **Step 2: Verify the file exists and has no syntax errors**

```bash
cd "Laptop Agent"
node -e "require('./src/main/pixelMonitor.js'); console.log('OK')"
```

Expected output: `OK`

- [ ] **Step 3: Commit**

```bash
git add src/main/pixelMonitor.js
git commit -m "feat: add pixelMonitor core module"
```

---

## Task 3: electron-store defaults + IPC handlers in index.js

**Files:**
- Modify: `Laptop Agent/src/main/index.js`

- [ ] **Step 1: Add pixelMonitor to store defaults and import the module**

At the top of `src/main/index.js`, after the existing requires, add:

```js
const pixelMonitor = require('./pixelMonitor')
```

Replace the existing `new Store({...})` block with:

```js
const store = new Store({
  name: 'csr-agent',
  defaults: {
    buttons: [],
    categories: [],
    settings: { supabaseUrl: '', supabaseKey: '', agentId: '' },
    pixelMonitor: {
      enabled: false,
      region: null,
      intervalMs: 500,
      tolerance: 30,
      calibration: { live_call: null, hung_up: null, idle: null }
    }
  }
})
```

- [ ] **Step 2: Add pixelMonitor state variable and Supabase upsert helper**

After `const executingIds = new Set()`, add:

```js
let currentCallStatus = 'idle'
```

After the `pushAllButtonsToSupabase` function, add:

```js
async function pushCallStatusToSupabase(status) {
  if (!supabase) return
  const { agentId } = store.get('settings')
  if (!agentId) return
  const { error } = await supabase
    .from('agent_status')
    .upsert({ agent_id: agentId, status, updated_at: new Date().toISOString() }, { onConflict: 'agent_id' })
  if (error) console.error('[PixelMonitor] Supabase upsert error:', error.message)
}
```

- [ ] **Step 3: Add a function to start/stop pixel monitoring based on store config**

After `pushCallStatusToSupabase`, add:

```js
function syncPixelMonitor() {
  const pm = store.get('pixelMonitor')
  pixelMonitor.stop()
  if (!pm.enabled || !pm.region) return
  if (!pm.calibration.live_call && !pm.calibration.hung_up && !pm.calibration.idle) return

  pixelMonitor.start(
    {
      region: pm.region,
      calibration: pm.calibration,
      intervalMs: pm.intervalMs,
      tolerance: pm.tolerance,
      debounceCount: 3
    },
    (status) => {
      currentCallStatus = status
      mainWindow?.webContents.send('pixelMonitor:status', { status })
      pushCallStatusToSupabase(status)
    }
  )
}
```

- [ ] **Step 4: Call syncPixelMonitor after Supabase init**

In `initSupabase()`, at the very end (after the try/catch block), add:

```js
  syncPixelMonitor()
```

Also call it on app ready. In `app.whenReady().then(async () => {`, after `await initSupabase()`, add:

```js
  syncPixelMonitor()
```

- [ ] **Step 5: Add IPC handlers at the bottom of index.js (before the window controls section)**

```js
// ── Pixel Monitor IPC ─────────────────────────────────────────────────────────
ipcMain.handle('pixelMonitor:getConfig', () => store.get('pixelMonitor'))

ipcMain.handle('pixelMonitor:saveConfig', (_, patch) => {
  const current = store.get('pixelMonitor')
  const updated = { ...current, ...patch }
  store.set('pixelMonitor', updated)
  syncPixelMonitor()
  return updated
})

ipcMain.handle('pixelMonitor:calibrate', async (_, { state }) => {
  const pm = store.get('pixelMonitor')
  if (!pm.region) return { ok: false, error: 'No region selected' }
  try {
    const color = await pixelMonitor.sampleRegion(pm.region)
    if (!color) return { ok: false, error: 'Capture returned no pixels' }
    const calibration = { ...pm.calibration, [state]: color }
    store.set('pixelMonitor', { ...pm, calibration })
    syncPixelMonitor()
    return { ok: true, color }
  } catch (e) {
    return { ok: false, error: e.message }
  }
})

ipcMain.handle('pixelMonitor:getStatus', () => ({ status: currentCallStatus }))
```

- [ ] **Step 6: Add region capture IPC handlers**

Add a `pendingRegionCaptureId` variable near the other pending state variables at the top:

```js
let pendingRegionCapture = false
```

Then add the IPC handlers:

```js
// ── Region capture ─────────────────────────────────────────────────────────────
ipcMain.handle('capture:startRegion', () => {
  pendingRegionCapture = true
  const { bounds } = screen.getPrimaryDisplay()
  overlayWindow.setBounds(bounds)
  mainWindow.minimize()
  setTimeout(() => {
    overlayWindow.show()
    overlayWindow.focus()
    overlayWindow.webContents.send('overlay:activateRegion')
  }, 280)
})

ipcMain.handle('capture:submitRegion', (_, region) => {
  overlayWindow.hide()
  pendingRegionCapture = false
  setTimeout(() => {
    mainWindow.restore()
    mainWindow.focus()
    const pm = store.get('pixelMonitor')
    store.set('pixelMonitor', { ...pm, region })
    mainWindow?.webContents.send('capture:resultRegion', region)
  }, 120)
})

ipcMain.handle('capture:cancelRegion', () => {
  overlayWindow.hide()
  pendingRegionCapture = false
  setTimeout(() => { mainWindow.restore(); mainWindow.focus() }, 120)
})
```

- [ ] **Step 7: Commit**

```bash
git add src/main/index.js
git commit -m "feat: integrate pixelMonitor into main process with IPC handlers"
```

---

## Task 4: Preload — expose new IPC channels

**Files:**
- Modify: `Laptop Agent/src/preload/index.js`

- [ ] **Step 1: Add pixel monitor and region capture APIs to the contextBridge**

In `src/preload/index.js`, inside the `contextBridge.exposeInMainWorld('api', { ... })` object, append before the closing `})`:

```js
  // --- Pixel Monitor ---
  getPixelMonitorConfig: () => ipcRenderer.invoke('pixelMonitor:getConfig'),
  savePixelMonitorConfig: (patch) => ipcRenderer.invoke('pixelMonitor:saveConfig', patch),
  calibratePixelMonitor: (state) => ipcRenderer.invoke('pixelMonitor:calibrate', { state }),
  getPixelMonitorStatus: () => ipcRenderer.invoke('pixelMonitor:getStatus'),

  // --- Region capture ---
  startRegionCapture: () => ipcRenderer.invoke('capture:startRegion'),
  submitRegionCapture: (region) => ipcRenderer.invoke('capture:submitRegion', region),
  cancelRegionCapture: () => ipcRenderer.invoke('capture:cancelRegion'),

  onPixelMonitorStatus: (cb) => {
    const h = (_, d) => cb(d)
    ipcRenderer.on('pixelMonitor:status', h)
    return () => ipcRenderer.off('pixelMonitor:status', h)
  },
  onRegionCaptureResult: (cb) => {
    const h = (_, d) => cb(d)
    ipcRenderer.on('capture:resultRegion', h)
    return () => ipcRenderer.off('capture:resultRegion', h)
  },
  onOverlayActivateRegion: (cb) => {
    const h = () => cb()
    ipcRenderer.on('overlay:activateRegion', h)
    return () => ipcRenderer.off('overlay:activateRegion', h)
  },
```

- [ ] **Step 2: Commit**

```bash
git add src/preload/index.js
git commit -m "feat: expose pixelMonitor and region capture IPC in preload"
```

---

## Task 5: Overlay — region-select drag mode

**Files:**
- Modify: `Laptop Agent/src/renderer/src/components/Overlay.jsx`

- [ ] **Step 1: Replace Overlay.jsx with the extended version supporting both modes**

```jsx
import { useState, useEffect, useRef, useCallback } from 'react'
import { Crosshair, RectangleHorizontal } from 'lucide-react'

export default function Overlay() {
  const [mode, setMode] = useState(null) // null | 'point' | 'region'
  const rootRef = useRef(null)

  // drag state for region mode
  const dragStart = useRef(null)
  const [dragRect, setDragRect] = useState(null) // { x, y, w, h } in screen px (CSS px for display)

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
```

- [ ] **Step 2: Commit**

```bash
git add src/renderer/src/components/Overlay.jsx
git commit -m "feat: add region-select drag mode to overlay"
```

---

## Task 6: Settings — Pixel Monitoring section

**Files:**
- Modify: `Laptop Agent/src/renderer/src/components/Settings.jsx`

- [ ] **Step 1: Replace Settings.jsx with the extended version**

```jsx
import { useState, useEffect } from 'react'
import { X, Eye, EyeOff, CheckCircle2, XCircle, Loader2, Wifi, Radio, RectangleHorizontal } from 'lucide-react'

const INTERVALS = [
  { label: '500ms', value: 500 },
  { label: '750ms', value: 750 },
  { label: '1s', value: 1000 }
]

const STATES = [
  { key: 'live_call', label: 'Live Call', dot: 'bg-emerald-500' },
  { key: 'hung_up',   label: 'Hung Up',  dot: 'bg-rose-500' },
  { key: 'idle',      label: 'Idle',     dot: 'bg-slate-400' }
]

export default function Settings({ onClose }) {
  const [form, setForm] = useState({ supabaseUrl: '', supabaseKey: '', agentId: '' })
  const [showKey, setShowKey] = useState(false)
  const [testState, setTestState] = useState(null)
  const [testError, setTestError] = useState('')
  const [saving, setSaving] = useState(false)

  // Pixel monitor state
  const [pm, setPm] = useState({
    enabled: false,
    region: null,
    intervalMs: 500,
    tolerance: 30,
    calibration: { live_call: null, hung_up: null, idle: null }
  })
  const [calibrating, setCalibrating] = useState(null) // state key being calibrated
  const [calError, setCalError] = useState('')

  useEffect(() => {
    window.api.getSettings().then(s => { if (s) setForm(s) })
    window.api.getPixelMonitorConfig().then(c => { if (c) setPm(c) })
  }, [])

  useEffect(() => {
    const cleanup = window.api.onRegionCaptureResult((region) => {
      setPm(prev => ({ ...prev, region }))
    })
    return cleanup
  }, [])

  const handleTest = async () => {
    if (!form.supabaseUrl || !form.supabaseKey) return
    setTestState('testing'); setTestError('')
    const result = await window.api.testSupabase({ supabaseUrl: form.supabaseUrl, supabaseKey: form.supabaseKey })
    setTestState(result.ok ? 'ok' : 'error')
    if (!result.ok) setTestError(result.error || 'Connection failed')
  }

  const handleSave = async () => {
    setSaving(true)
    await window.api.saveSettings(form)
    await window.api.savePixelMonitorConfig({
      enabled: pm.enabled,
      intervalMs: pm.intervalMs,
      tolerance: pm.tolerance
    })
    setSaving(false)
    onClose()
  }

  const handlePmToggle = async (enabled) => {
    const updated = await window.api.savePixelMonitorConfig({ enabled })
    setPm(prev => ({ ...prev, ...updated }))
  }

  const handleIntervalChange = async (intervalMs) => {
    setPm(prev => ({ ...prev, intervalMs }))
  }

  const handleSelectRegion = () => {
    window.api.startRegionCapture()
    onClose() // close settings so overlay can show
  }

  const handleCalibrate = async (stateKey) => {
    setCalibrating(stateKey); setCalError('')
    const result = await window.api.calibratePixelMonitor(stateKey)
    setCalibrating(null)
    if (result.ok) {
      setPm(prev => ({
        ...prev,
        calibration: { ...prev.calibration, [stateKey]: result.color }
      }))
    } else {
      setCalError(result.error || 'Calibration failed')
    }
  }

  const field = (label, key, opts = {}) => (
    <div>
      <label className="block text-xs font-medium text-slate-400 mb-1.5">{label}</label>
      <div className="relative">
        <input
          type={opts.password && !showKey ? 'password' : 'text'}
          value={form[key]}
          onChange={e => setForm(f => ({ ...f, [key]: e.target.value }))}
          placeholder={opts.placeholder || ''}
          className="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-sm text-slate-200 placeholder-slate-600 focus:outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500/30 transition-colors"
          spellCheck={false}
        />
        {opts.password && (
          <button onClick={() => setShowKey(v => !v)} className="absolute right-2.5 top-1/2 -translate-y-1/2 text-slate-500 hover:text-slate-300">
            {showKey ? <EyeOff size={14} /> : <Eye size={14} />}
          </button>
        )}
      </div>
      {opts.hint && <p className="text-xs text-slate-600 mt-1">{opts.hint}</p>}
    </div>
  )

  const rgbToHex = (c) => c ? `#${[c.r, c.g, c.b].map(v => v.toString(16).padStart(2, '0')).join('')}` : null

  return (
    <div className="absolute inset-0 z-50 flex items-center justify-center bg-slate-950/80 backdrop-blur-sm">
      <div className="bg-slate-900 border border-slate-700/60 rounded-2xl w-full max-w-md mx-4 shadow-2xl shadow-black/60 max-h-[90vh] overflow-y-auto">
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-slate-800 sticky top-0 bg-slate-900 z-10">
          <div className="flex items-center gap-2.5">
            <div className="w-7 h-7 rounded-lg bg-blue-500/15 border border-blue-500/25 flex items-center justify-center">
              <Wifi size={13} className="text-blue-400" />
            </div>
            <span className="text-sm font-semibold text-slate-200">Settings</span>
          </div>
          <button onClick={onClose} className="w-7 h-7 flex items-center justify-center rounded-lg text-slate-500 hover:text-slate-200 hover:bg-slate-800 transition-colors">
            <X size={14} />
          </button>
        </div>

        {/* Supabase section */}
        <div className="px-6 py-5 space-y-4">
          <p className="text-xs text-slate-500 -mt-1">Connect to Supabase to sync buttons and receive remote click commands.</p>
          {field('Project URL', 'supabaseUrl', { placeholder: 'https://xxxx.supabase.co' })}
          {field('Anon / Service Key', 'supabaseKey', { password: true, placeholder: 'eyJhbGci...' })}
          {field('Agent ID', 'agentId', { placeholder: 'agent-001', hint: 'Unique ID for this machine — used to route commands to the right agent.' })}
          <div className="flex items-center gap-3 pt-1">
            <button onClick={handleTest} disabled={!form.supabaseUrl || !form.supabaseKey || testState === 'testing'}
              className="flex items-center gap-1.5 text-xs font-medium px-3 py-1.5 rounded-lg border border-slate-700 text-slate-300 hover:border-slate-500 hover:text-white disabled:opacity-40 disabled:cursor-not-allowed transition-colors">
              {testState === 'testing' ? <Loader2 size={12} className="animate-spin" /> : <Wifi size={12} />}
              Test Connection
            </button>
            {testState === 'ok' && <div className="flex items-center gap-1.5 text-xs text-emerald-400"><CheckCircle2 size={13} />Connected</div>}
            {testState === 'error' && <div className="flex items-center gap-1.5 text-xs text-rose-400"><XCircle size={13} />{testError || 'Failed'}</div>}
          </div>
        </div>

        {/* Divider */}
        <div className="mx-6 border-t border-slate-800" />

        {/* Pixel Monitoring section */}
        <div className="px-6 py-5 space-y-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <div className="w-7 h-7 rounded-lg bg-violet-500/15 border border-violet-500/25 flex items-center justify-center">
                <Radio size={13} className="text-violet-400" />
              </div>
              <span className="text-sm font-semibold text-slate-200">Pixel Monitoring</span>
            </div>
            {/* Toggle */}
            <button
              onClick={() => handlePmToggle(!pm.enabled)}
              disabled={!pm.region}
              title={!pm.region ? 'Select a region first' : ''}
              className={`relative w-10 h-5 rounded-full transition-colors ${pm.enabled ? 'bg-violet-600' : 'bg-slate-700'} disabled:opacity-40 disabled:cursor-not-allowed`}
            >
              <span className={`absolute top-0.5 left-0.5 w-4 h-4 rounded-full bg-white shadow transition-transform ${pm.enabled ? 'translate-x-5' : 'translate-x-0'}`} />
            </button>
          </div>

          <p className="text-xs text-slate-500">Select a region on your VICIdial screen, calibrate colors, and the agent will automatically detect your call status.</p>

          {/* Region select */}
          <div>
            <label className="block text-xs font-medium text-slate-400 mb-1.5">Monitor Region</label>
            <div className="flex items-center gap-2">
              <button onClick={handleSelectRegion}
                className="flex items-center gap-1.5 text-xs font-medium px-3 py-1.5 rounded-lg border border-slate-700 text-slate-300 hover:border-slate-500 hover:text-white transition-colors">
                <RectangleHorizontal size={12} />
                {pm.region ? 'Recalibrate Region' : 'Select Region'}
              </button>
              {pm.region && (
                <span className="text-xs text-slate-500 font-mono">
                  {pm.region.x},{pm.region.y} · {pm.region.width}×{pm.region.height}
                </span>
              )}
            </div>
          </div>

          {/* Polling interval */}
          <div>
            <label className="block text-xs font-medium text-slate-400 mb-1.5">Polling Interval</label>
            <div className="flex gap-1.5">
              {INTERVALS.map(({ label, value }) => (
                <button key={value} onClick={() => handleIntervalChange(value)}
                  className={`px-3 py-1 text-xs rounded-lg border transition-colors ${pm.intervalMs === value ? 'bg-violet-600/20 border-violet-500/40 text-violet-300' : 'border-slate-700 text-slate-400 hover:border-slate-500'}`}>
                  {label}
                </button>
              ))}
            </div>
          </div>

          {/* Tolerance */}
          <div>
            <label className="block text-xs font-medium text-slate-400 mb-1.5">
              Color Tolerance <span className="text-slate-600 font-normal">(RGB distance 10–60)</span>
            </label>
            <input type="number" min={10} max={60} value={pm.tolerance}
              onChange={e => setPm(prev => ({ ...prev, tolerance: Number(e.target.value) }))}
              className="w-24 bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-sm text-slate-200 focus:outline-none focus:border-violet-500 focus:ring-1 focus:ring-violet-500/30 transition-colors" />
          </div>

          {/* Calibration */}
          <div>
            <label className="block text-xs font-medium text-slate-400 mb-2">Calibrate Colors</label>
            <p className="text-xs text-slate-600 mb-3">With VICIdial visible in each state, click Calibrate to sample the region color.</p>
            <div className="space-y-2">
              {STATES.map(({ key, label, dot }) => {
                const color = pm.calibration[key]
                const hex = rgbToHex(color)
                return (
                  <div key={key} className="flex items-center gap-3">
                    <button
                      onClick={() => handleCalibrate(key)}
                      disabled={!pm.region || calibrating === key}
                      className="flex items-center gap-1.5 text-xs font-medium px-3 py-1.5 rounded-lg border border-slate-700 text-slate-300 hover:border-slate-500 hover:text-white disabled:opacity-40 disabled:cursor-not-allowed transition-colors min-w-[120px]"
                    >
                      {calibrating === key ? <Loader2 size={11} className="animate-spin" /> : <div className={`w-2 h-2 rounded-full ${dot}`} />}
                      {label}
                    </button>
                    {hex && (
                      <div className="flex items-center gap-1.5">
                        <div className="w-4 h-4 rounded border border-slate-600" style={{ backgroundColor: hex }} />
                        <span className="text-xs text-slate-500 font-mono">{hex}</span>
                      </div>
                    )}
                  </div>
                )
              })}
            </div>
            {calError && <p className="text-xs text-rose-400 mt-2">{calError}</p>}
          </div>
        </div>

        {/* Footer */}
        <div className="flex items-center justify-end gap-2 px-6 py-4 border-t border-slate-800 sticky bottom-0 bg-slate-900">
          <button onClick={onClose} className="px-4 py-2 text-sm text-slate-400 hover:text-slate-200 transition-colors">Cancel</button>
          <button onClick={handleSave} disabled={saving}
            className="flex items-center gap-1.5 px-4 py-2 bg-blue-600 hover:bg-blue-500 disabled:opacity-60 text-white text-sm font-medium rounded-lg transition-colors">
            {saving && <Loader2 size={13} className="animate-spin" />}
            Save Settings
          </button>
        </div>
      </div>
    </div>
  )
}
```

- [ ] **Step 2: Commit**

```bash
git add src/renderer/src/components/Settings.jsx
git commit -m "feat: add pixel monitoring section to Settings"
```

---

## Task 7: TitleBar — call status badge

**Files:**
- Modify: `Laptop Agent/src/renderer/src/components/TitleBar.jsx`

- [ ] **Step 1: Replace TitleBar.jsx**

```jsx
import { Minus, Square, X, Settings } from 'lucide-react'

const STATUS_CONFIG = {
  live_call: { dot: 'bg-emerald-500 shadow-emerald-500/50', text: 'text-emerald-400', label: 'Live Call' },
  hung_up:   { dot: 'bg-rose-500 shadow-rose-500/50',     text: 'text-rose-400',    label: 'Hung Up' },
  idle:      { dot: 'bg-slate-500',                        text: 'text-slate-500',   label: 'Idle' }
}

export default function TitleBar({ onSettings, supabaseConnected, callStatus, pixelMonitorEnabled }) {
  const statusCfg = callStatus ? STATUS_CONFIG[callStatus] : null

  return (
    <div className="drag-region flex items-center h-10 bg-slate-900 border-b border-slate-800 px-4 flex-shrink-0">
      {/* App identity */}
      <div className="flex items-center gap-2">
        <div className="w-2.5 h-2.5 rounded-full bg-blue-500 shadow-lg shadow-blue-500/50" />
        <span className="text-sm font-semibold text-slate-200 tracking-wide">CSR Agent</span>
        <span className="text-xs text-slate-500 ml-1">v0.2</span>
      </div>

      {/* Supabase connection dot */}
      {supabaseConnected !== null && (
        <div className="flex items-center gap-1.5 ml-4">
          <div className={`w-1.5 h-1.5 rounded-full ${supabaseConnected ? 'bg-emerald-500' : 'bg-slate-600'}`} />
          <span className="text-xs text-slate-600">{supabaseConnected ? 'Synced' : 'Local'}</span>
        </div>
      )}

      {/* Call status badge */}
      {pixelMonitorEnabled && statusCfg && (
        <div className="flex items-center gap-1.5 ml-4 px-2 py-0.5 rounded-full bg-slate-800 border border-slate-700/60">
          <div className={`w-1.5 h-1.5 rounded-full shadow-md ${statusCfg.dot}`} />
          <span className={`text-xs font-medium ${statusCfg.text}`}>{statusCfg.label}</span>
        </div>
      )}

      <div className="flex-1" />

      {/* Settings + Window controls */}
      <div className="no-drag flex items-center gap-1">
        <button onClick={onSettings} className="w-7 h-7 flex items-center justify-center rounded text-slate-500 hover:text-slate-200 hover:bg-slate-700 transition-colors" title="Settings">
          <Settings size={13} />
        </button>
        <div className="w-px h-4 bg-slate-800 mx-1" />
        <button onClick={() => window.api.minimize()} className="w-7 h-7 flex items-center justify-center rounded text-slate-500 hover:text-slate-200 hover:bg-slate-700 transition-colors">
          <Minus size={13} />
        </button>
        <button onClick={() => window.api.maximize()} className="w-7 h-7 flex items-center justify-center rounded text-slate-500 hover:text-slate-200 hover:bg-slate-700 transition-colors">
          <Square size={11} />
        </button>
        <button onClick={() => window.api.close()} className="w-7 h-7 flex items-center justify-center rounded text-slate-500 hover:text-white hover:bg-red-600 transition-colors">
          <X size={13} />
        </button>
      </div>
    </div>
  )
}
```

- [ ] **Step 2: Commit**

```bash
git add src/renderer/src/components/TitleBar.jsx
git commit -m "feat: add call status badge to TitleBar"
```

---

## Task 8: MainLayout — wire pixel monitor events

**Files:**
- Modify: `Laptop Agent/src/renderer/src/components/MainLayout.jsx`

- [ ] **Step 1: Add callStatus state and pixelMonitor IPC listener**

At the top of `MainLayout`, after the existing imports, the state changes are:

1. After `const [toast, setToast] = useState(null)`, add:
```js
const [callStatus, setCallStatus] = useState('idle')
const [pixelMonitorEnabled, setPixelMonitorEnabled] = useState(false)
```

2. In the first `useEffect` (that loads buttons/categories), add:
```js
window.api.getPixelMonitorConfig().then(c => {
  if (c) setPixelMonitorEnabled(c.enabled)
})
window.api.getPixelMonitorStatus().then(d => {
  if (d) setCallStatus(d.status)
})
```

3. In the second `useEffect` (that registers IPC listeners), add to the `cleanups` array:
```js
window.api.onPixelMonitorStatus((d) => {
  setCallStatus(d.status)
}),
```

4. Update the `TitleBar` JSX line to pass the new props:
```jsx
<TitleBar
  onSettings={() => setShowSettings(true)}
  supabaseConnected={supabaseConnected}
  callStatus={callStatus}
  pixelMonitorEnabled={pixelMonitorEnabled}
/>
```

- [ ] **Step 2: Commit**

```bash
git add src/renderer/src/components/MainLayout.jsx
git commit -m "feat: wire pixelMonitor status events in MainLayout"
```

- [ ] **Step 3: Push Laptop Agent feature branch**

```bash
git push origin feature/pixel-monitoring
```

---

## Task 9: Web App — branch setup + types + CallStatusBadge

**Files:**
- Create branch: `feature/pixel-monitoring` in Web App
- Modify: `Web App/src/lib/types.ts`
- Create: `Web App/src/components/CallStatusBadge.tsx`

- [ ] **Step 1: Create feature branch in Web App**

```bash
cd "Web App"
git checkout -b feature/pixel-monitoring
```

- [ ] **Step 2: Add AgentStatus type to types.ts**

Append to `src/lib/types.ts`:

```ts
export interface AgentStatus {
  id: string
  agent_id: string
  status: 'live_call' | 'hung_up' | 'idle'
  updated_at: string
}
```

- [ ] **Step 3: Create CallStatusBadge.tsx**

Create `src/components/CallStatusBadge.tsx`:

```tsx
'use client'

import { useState, useEffect } from 'react'
import { supabase } from '@/lib/supabase'
import type { AgentStatus } from '@/lib/types'

const AGENT_ID = process.env.NEXT_PUBLIC_AGENT_ID!
const POLL_MS = 5000

const CONFIG = {
  live_call: { dot: 'bg-emerald-500', text: 'text-emerald-600', label: 'Live Call', ring: 'ring-emerald-200' },
  hung_up:   { dot: 'bg-rose-500',    text: 'text-rose-600',    label: 'Hung Up',  ring: 'ring-rose-200' },
  idle:      { dot: 'bg-slate-400',   text: 'text-slate-500',   label: 'Idle',     ring: 'ring-slate-200' }
} as const

export default function CallStatusBadge() {
  const [status, setStatus] = useState<AgentStatus['status'] | null>(null)

  const fetchStatus = async () => {
    const { data } = await supabase
      .from('agent_status')
      .select('status')
      .eq('agent_id', AGENT_ID)
      .single<Pick<AgentStatus, 'status'>>()
    if (data) setStatus(data.status)
  }

  useEffect(() => {
    fetchStatus()

    const channel = supabase
      .channel('agent-status-live')
      .on(
        'postgres_changes',
        { event: 'UPDATE', schema: 'public', table: 'agent_status', filter: `agent_id=eq.${AGENT_ID}` },
        (payload) => {
          const row = payload.new as AgentStatus
          setStatus(row.status)
        }
      )
      .subscribe((s) => {
        if (s !== 'SUBSCRIBED') {
          // Realtime unavailable — rely on polling
        }
      })

    const poll = setInterval(fetchStatus, POLL_MS)

    return () => {
      supabase.removeChannel(channel)
      clearInterval(poll)
    }
  }, [])

  if (status === null) return null

  const cfg = CONFIG[status]

  return (
    <div className={`flex items-center gap-1.5 px-2 py-1 rounded-full bg-white border border-slate-200 ring-1 ${cfg.ring} shadow-sm`}>
      <span className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${cfg.dot}`} />
      <span className={`text-xs font-semibold ${cfg.text}`}>{cfg.label}</span>
    </div>
  )
}
```

- [ ] **Step 4: Commit**

```bash
git add src/lib/types.ts src/components/CallStatusBadge.tsx
git commit -m "feat: add AgentStatus type and CallStatusBadge component"
```

---

## Task 10: Web App — mount badge in Dashboard header

**Files:**
- Modify: `Web App/src/components/Dashboard.tsx`

- [ ] **Step 1: Import and mount CallStatusBadge**

At the top of `Dashboard.tsx`, add the import after the existing imports:

```tsx
import CallStatusBadge from './CallStatusBadge'
```

In the header JSX, find the existing connection indicator + buttons group:

```tsx
<div className="flex items-center gap-2">
  <div className="flex items-center gap-1.5 mr-1">
    {connected ? <Wifi size={13} className="text-emerald-500" /> : <WifiOff size={13} className="text-slate-400" />}
    <span className="text-xs text-slate-400 hidden sm:inline">{connected ? 'Live' : 'Offline'}</span>
  </div>
  <button ...>Activity</button>
  <button ...>Stop</button>
</div>
```

Add `<CallStatusBadge />` between the wifi indicator and the Activity button:

```tsx
<div className="flex items-center gap-2">
  <div className="flex items-center gap-1.5 mr-1">
    {connected ? <Wifi size={13} className="text-emerald-500" /> : <WifiOff size={13} className="text-slate-400" />}
    <span className="text-xs text-slate-400 hidden sm:inline">{connected ? 'Live' : 'Offline'}</span>
  </div>
  <CallStatusBadge />
  <button onClick={() => setShowActivity(v => !v)} className={`flex items-center gap-1.5 text-xs px-2.5 py-1.5 rounded-lg border transition-colors ${showActivity ? 'bg-blue-50 border-blue-200 text-blue-600' : 'bg-white border-slate-200 text-slate-500 hover:bg-slate-50'}`}>
    <Activity size={12} /><span className="hidden sm:inline">Activity</span>
  </button>
  <button onClick={emergencyStop} className="flex items-center gap-1.5 text-xs px-2.5 py-1.5 rounded-lg bg-rose-500 hover:bg-rose-600 border border-rose-400 text-white transition-colors">
    <OctagonX size={12} /><span className="hidden sm:inline">Stop</span>
  </button>
</div>
```

- [ ] **Step 2: Commit and push Web App branch**

```bash
git add src/components/Dashboard.tsx
git commit -m "feat: mount CallStatusBadge in Dashboard header"
git push -u origin feature/pixel-monitoring
```

---

## Manual Test Checklist

Run these after all tasks are complete:

```
Laptop Agent:
[ ] npm run dev starts without errors
[ ] Settings opens and shows "Pixel Monitoring" section
[ ] "Select Region" closes settings and shows drag overlay
[ ] Dragging on the overlay draws a live rectangle
[ ] Releasing mouse stores region coords (shown in Settings)
[ ] Calibrate Live Call samples a color and shows hex swatch
[ ] Calibrate Hung Up and Idle do the same
[ ] Enable toggle activates (requires region selected)
[ ] TitleBar badge appears showing current status
[ ] Changing VICIdial state causes badge to update within 1-2s

Web App:
[ ] npm run dev starts without errors
[ ] Dashboard header shows CallStatusBadge pill
[ ] Changing VICIdial state on laptop causes badge to update in webapp within 2s
[ ] If pixel monitoring disabled, badge disappears (status row never written)
```
