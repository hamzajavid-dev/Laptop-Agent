const { app, BrowserWindow, ipcMain, screen, desktopCapturer } = require('electron')
const { join } = require('path')
const { randomUUID } = require('crypto')
const { execFile } = require('child_process')
const Store = require('electron-store')
const { createClient } = require('@supabase/supabase-js')
// ── Pixel Monitor (inlined to avoid Rollup CJS bundling issues) ───────────────
const pixelMonitor = (() => {

  let _timer = null, _lastConfirmed = null, _readings = [], _onStatusChange = null, _config = null, _ticking = false

  async function _captureRegionAvgColor(region) {
    const display = screen.getPrimaryDisplay()
    const { width, height } = display.size
    const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width, height } })
    if (!sources.length) return null
    const cropped = sources[0].thumbnail.crop({ x: Math.round(region.x), y: Math.round(region.y), width: Math.max(1, Math.round(region.width)), height: Math.max(1, Math.round(region.height)) })
    const bitmap = cropped.toBitmap()
    if (!bitmap.length) return null
    let r = 0, g = 0, b = 0
    const pixelCount = bitmap.length / 4
    for (let i = 0; i < bitmap.length; i += 4) { r += bitmap[i]; g += bitmap[i + 1]; b += bitmap[i + 2] }
    return { r: Math.round(r / pixelCount), g: Math.round(g / pixelCount), b: Math.round(b / pixelCount) }
  }

  function _colorDistance(a, b) { return Math.sqrt((a.r - b.r) ** 2 + (a.g - b.g) ** 2 + (a.b - b.b) ** 2) }

  function _classify(avg, calibration, tolerance) {
    const states = ['live_call', 'hung_up', 'idle']
    let best = null, bestDist = Infinity
    for (const state of states) { const cal = calibration[state]; if (!cal) continue; const dist = _colorDistance(avg, cal); if (dist < bestDist) { bestDist = dist; best = state } }
    if (best === null || bestDist > tolerance) return 'idle'
    return best
  }

  async function _tick() {
    if (_ticking || !_config) return
    _ticking = true
    try {
      const avg = await _captureRegionAvgColor(_config.region)
      if (!avg) return
      const detected = _classify(avg, _config.calibration, _config.tolerance)
      _readings.push(detected)
      if (_readings.length > _config.debounceCount) _readings.shift()
      if (_readings.length === _config.debounceCount && _readings.every(r => r === _readings[0]) && _readings[0] !== _lastConfirmed) {
        _lastConfirmed = _readings[0]
        if (_onStatusChange) _onStatusChange(_readings[0])
      }
    } catch (e) { console.warn('[PixelMonitor] tick error:', e.message) } finally { _ticking = false }
  }

  return {
    start(config, onStatusChange) {
      if (_timer) { clearInterval(_timer); _timer = null }
      _readings = []; _lastConfirmed = null
      _config = config; _onStatusChange = onStatusChange
      _tick()
      _timer = setInterval(_tick, config.intervalMs)
    },
    stop() { if (_timer) { clearInterval(_timer); _timer = null }; _readings = []; _lastConfirmed = null },
    async sampleRegion(region) { return _captureRegionAvgColor(region) }
  }
})()

// ── Persistent store ─────────────────────────────────────────────────────────
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

// ── App state ────────────────────────────────────────────────────────────────
let mainWindow = null
let overlayWindow = null
let pendingCaptureId = null
let pendingRegionCapture = false
let supabase = null
let realtimeChannel = null
let pollInterval = null
const executingIds = new Set()
let currentCallStatus = 'idle'

const isDev = process.env.NODE_ENV !== 'production'
const rendererUrl = process.env['ELECTRON_RENDERER_URL']

// ── Execution engine (PowerShell — no native deps needed) ───────────────────
function clickAt(x, y) {
  const script = [
    'Add-Type -AssemblyName System.Windows.Forms',
    `[System.Windows.Forms.Cursor]::Position = New-Object System.Drawing.Point(${x}, ${y})`,
    "Add-Type -MemberDefinition '[DllImport(\"user32.dll\")] public static extern void mouse_event(int f,int x,int y,int d,int e);' -Name 'Input' -Namespace 'Win32'",
    '[Win32.Input]::mouse_event(0x0002,0,0,0,0)',
    '[Win32.Input]::mouse_event(0x0004,0,0,0,0)'
  ].join('; ')

  return new Promise((resolve, reject) => {
    execFile('powershell', ['-NoProfile', '-NonInteractive', '-Command', script], (err) => {
      if (err) reject(new Error('Click failed: ' + err.message))
      else resolve()
    })
  })
}

async function executeButtonById(buttonId) {
  const buttons = store.get('buttons')
  const button = buttons.find(b => b.id === buttonId)
  if (!button) throw new Error('Button not found')
  if (!button.coordinates) throw new Error('Button has no coordinates')
  if (!button.active) throw new Error('Button is inactive')
  await clickAt(button.coordinates.x, button.coordinates.y)
}

// ── Supabase ─────────────────────────────────────────────────────────────────
async function initSupabase() {
  const { supabaseUrl, supabaseKey, agentId } = store.get('settings')

  // Tear down previous connection
  stopPolling()
  if (realtimeChannel && supabase) {
    supabase.removeChannel(realtimeChannel)
    realtimeChannel = null
  }
  supabase = null

  if (!supabaseUrl || !supabaseKey) return

  try {
    supabase = createClient(supabaseUrl, supabaseKey)
    if (agentId) await pullFromSupabase(agentId)
    if (agentId) startRealtimeListener(agentId)
    mainWindow?.webContents.send('supabase:status', { connected: true })
    syncPixelMonitor()
  } catch (e) {
    console.error('[Supabase] init failed:', e.message)
    supabase = null
    mainWindow?.webContents.send('supabase:status', { connected: false, error: e.message })
  }
}

async function pullFromSupabase(agentId) {
  const { data: buttons, error: bErr } = await supabase
    .from('buttons')
    .select('*')
    .eq('agent_id', agentId)
    .order('order', { ascending: true })

  if (bErr) { console.error('[Supabase] pull buttons error:', bErr.message); return }

  const { data: categories, error: cErr } = await supabase
    .from('categories')
    .select('*')
    .eq('agent_id', agentId)
    .order('order', { ascending: true })

  if (cErr) { console.error('[Supabase] pull categories error:', cErr.message); return }

  const mapped = (buttons ?? []).map(b => ({
    id: b.id,
    name: b.name,
    category: b.category || '',
    coordinates: b.coordinates || null,
    active: b.active ?? true,
    order: b.order ?? 0,
    color: b.color || null,
    createdAt: b.created_at
  }))

  store.set('buttons', mapped)
  store.set('categories', categories ?? [])

  console.log(`[Supabase] pulled ${mapped.length} buttons, ${(categories ?? []).length} categories`)
  mainWindow?.webContents.send('buttons:synced', { buttons: mapped, categories: categories ?? [] })
}

async function pushCallStatusToSupabase(status) {
  if (!supabase) return
  const { agentId } = store.get('settings')
  if (!agentId) return
  const { error } = await supabase
    .from('agent_status')
    .upsert({ agent_id: agentId, status, updated_at: new Date().toISOString() }, { onConflict: 'agent_id' })
  if (error) console.error('[PixelMonitor] Supabase upsert error:', error.message)
}

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

async function handleCommand(cmd) {
  if (cmd.status !== 'pending') return
  if (executingIds.has(cmd.id)) return
  executingIds.add(cmd.id)

  mainWindow?.webContents.send('command:incoming', {
    id: cmd.id,
    buttonId: cmd.button_id,
    buttonName: cmd.button_name
  })

  try {
    await executeButtonById(cmd.button_id)
    await supabase
      .from('commands')
      .update({ status: 'done', executed_at: new Date().toISOString() })
      .eq('id', cmd.id)
    mainWindow?.webContents.send('command:result', { id: cmd.id, status: 'done' })
  } catch (e) {
    await supabase
      .from('commands')
      .update({ status: 'error', error_message: e.message })
      .eq('id', cmd.id)
    mainWindow?.webContents.send('command:result', { id: cmd.id, status: 'error', error: e.message })
  } finally {
    executingIds.delete(cmd.id)
  }
}

async function drainPendingCommands(agentId) {
  const { data, error } = await supabase
    .from('commands')
    .select('*')
    .eq('agent_id', agentId)
    .eq('status', 'pending')
    .order('created_at', { ascending: true })
  if (error) { console.error('[Supabase] drain pending error:', error.message); return }
  for (const cmd of data ?? []) {
    await handleCommand(cmd)
  }
}

function startPolling(agentId) {
  if (pollInterval) clearInterval(pollInterval)
  pollInterval = setInterval(() => drainPendingCommands(agentId), 300)
  console.log('[Supabase] polling fallback active (500ms interval)')
}

function stopPolling() {
  if (pollInterval) { clearInterval(pollInterval); pollInterval = null }
}

function startRealtimeListener(agentId) {
  realtimeChannel = supabase
    .channel(`commands:${agentId}`)
    .on(
      'postgres_changes',
      {
        event: 'INSERT',
        schema: 'public',
        table: 'commands',
        filter: `agent_id=eq.${agentId}`
      },
      (payload) => handleCommand(payload.new)
    )
    .subscribe((status, err) => {
      console.log('[Supabase] realtime status:', status, err ?? '')
      mainWindow?.webContents.send('supabase:realtime', { status })
      if (status === 'SUBSCRIBED') {
        stopPolling()
        drainPendingCommands(agentId)
      } else if (status === 'TIMED_OUT' || status === 'CHANNEL_ERROR' || status === 'CLOSED') {
        startPolling(agentId)
      }
    })
}

// ── Window creation ──────────────────────────────────────────────────────────
function createMainWindow() {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 750,
    minWidth: 900,
    minHeight: 580,
    show: false,
    frame: false,
    backgroundColor: '#020617',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false
    }
  })

  mainWindow.once('ready-to-show', () => mainWindow.show())

  if (isDev && rendererUrl) {
    mainWindow.loadURL(rendererUrl)
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

function createOverlayWindow() {
  overlayWindow = new BrowserWindow({
    show: false,
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: false,
    focusable: true,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false
    }
  })

  if (isDev && rendererUrl) {
    overlayWindow.loadURL(`${rendererUrl}?mode=overlay`)
  } else {
    overlayWindow.loadFile(join(__dirname, '../renderer/index.html'), {
      query: { mode: 'overlay' }
    })
  }
}

app.whenReady().then(async () => {
  createMainWindow()
  createOverlayWindow()
  await initSupabase()
  syncPixelMonitor()
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

// ── Settings IPC ─────────────────────────────────────────────────────────────
ipcMain.handle('settings:get', () => store.get('settings'))

ipcMain.handle('settings:save', async (_, settings) => {
  store.set('settings', settings)
  await initSupabase()
  return { ok: true }
})

ipcMain.handle('settings:test', async (_, { supabaseUrl, supabaseKey }) => {
  try {
    const client = createClient(supabaseUrl, supabaseKey)
    const { error } = await client.from('buttons').select('id').limit(1)
    return error ? { ok: false, error: error.message } : { ok: true }
  } catch (e) {
    return { ok: false, error: e.message }
  }
})

// ── Button CRUD ───────────────────────────────────────────────────────────────
ipcMain.handle('buttons:getAll', () => store.get('buttons'))

ipcMain.handle('buttons:save', async (_, button) => {
  const buttons = store.get('buttons')
  let saved

  if (button.id) {
    const idx = buttons.findIndex(b => b.id === button.id)
    if (idx >= 0) { buttons[idx] = button } else { buttons.push(button) }
    saved = button
  } else {
    const sameCat = buttons.filter(b => (b.category || '') === (button.category || ''))
    const maxOrder = sameCat.reduce((m, b) => Math.max(m, b.order ?? 0), -1)
    saved = { ...button, id: randomUUID(), createdAt: new Date().toISOString(), order: maxOrder + 1 }
    buttons.push(saved)
  }

  store.set('buttons', buttons)

  if (!supabase) {
    console.warn('[Supabase] not connected — button saved locally only')
    mainWindow?.webContents.send('supabase:status', { connected: false, error: 'Not connected to Supabase' })
  } else {
    const { agentId } = store.get('settings')
    if (!agentId) {
      console.warn('[Supabase] agentId is empty — skipping sync')
      mainWindow?.webContents.send('supabase:status', { connected: false, error: 'Agent ID is not set in Settings' })
    } else {
      const row = {
        id: saved.id,
        agent_id: agentId,
        name: saved.name,
        category: saved.category || '',
        coordinates: saved.coordinates || null,
        active: saved.active ?? true,
        order: saved.order ?? 0,
        created_at: saved.createdAt,
        updated_at: new Date().toISOString()
      }
      if (saved.color) row.color = saved.color
      const { error } = await supabase.from('buttons').upsert(row)
      if (error) {
        console.error('[Supabase] save error:', error.message)
        mainWindow?.webContents.send('supabase:status', { connected: false, error: 'Button sync failed: ' + error.message })
      } else {
        console.log('[Supabase] button synced:', saved.id)
      }
    }
  }

  return store.get('buttons')
})

ipcMain.handle('buttons:delete', async (_, id) => {
  const buttons = store.get('buttons').filter(b => b.id !== id)
  store.set('buttons', buttons)
  if (!supabase) {
    console.warn('[Supabase] not connected — deletion is local only')
    mainWindow?.webContents.send('supabase:status', { connected: false, error: 'Not connected to Supabase' })
  } else {
    // Null out FK references in commands first to avoid constraint violations
    await supabase.from('commands').update({ button_id: null }).eq('button_id', id)
    const { error } = await supabase.from('buttons').delete().eq('id', id)
    if (error) {
      console.error('[Supabase] delete error:', error.message)
      mainWindow?.webContents.send('supabase:status', { connected: false, error: 'Delete failed: ' + error.message })
    } else {
      console.log('[Supabase] button deleted:', id)
    }
  }
  return buttons
})

// ── Button reorder ────────────────────────────────────────────────────────────
ipcMain.handle('buttons:reorder', async (_, { category, orderedIds }) => {
  const buttons = store.get('buttons')
  orderedIds.forEach((id, index) => {
    const btn = buttons.find(b => b.id === id)
    if (btn) btn.order = index
  })
  store.set('buttons', buttons)
  if (supabase) {
    const { agentId } = store.get('settings')
    const rows = orderedIds.map((id, index) => {
      const btn = buttons.find(b => b.id === id)
      return { id, agent_id: agentId, name: btn?.name || '', category: category || '', order: index, updated_at: new Date().toISOString() }
    })
    supabase.from('buttons').upsert(rows).then(({ error }) => {
      if (error) console.error('[Supabase] reorder error:', error.message)
    })
  }
  return store.get('buttons')
})

// ── Categories ────────────────────────────────────────────────────────────────
ipcMain.handle('categories:getAll', () => store.get('categories'))

ipcMain.handle('categories:save', async (_, category) => {
  const categories = store.get('categories')
  let saved

  if (category.id) {
    const idx = categories.findIndex(c => c.id === category.id)
    if (idx >= 0) { categories[idx] = category } else { categories.push(category) }
    saved = category
  } else {
    const maxOrder = categories.reduce((m, c) => Math.max(m, c.order ?? 0), -1)
    saved = { ...category, id: randomUUID(), order: maxOrder + 1 }
    categories.push(saved)
  }

  store.set('categories', categories)
  if (supabase) {
    const { agentId } = store.get('settings')
    supabase.from('categories').upsert({ id: saved.id, agent_id: agentId, name: saved.name, order: saved.order })
      .then(({ error }) => { if (error) console.error('[Supabase] category save:', error.message) })
  }
  return store.get('categories')
})

ipcMain.handle('categories:delete', async (_, id) => {
  const categories = store.get('categories').filter(c => c.id !== id)
  categories.forEach((c, i) => { c.order = i })
  store.set('categories', categories)
  if (supabase) {
    supabase.from('categories').delete().eq('id', id)
      .then(({ error }) => { if (error) console.error('[Supabase] category delete:', error.message) })
  }
  return categories
})

ipcMain.handle('categories:reorder', async (_, orderedIds) => {
  const categories = store.get('categories')
  orderedIds.forEach((id, index) => {
    const cat = categories.find(c => c.id === id)
    if (cat) cat.order = index
  })
  categories.sort((a, b) => (a.order ?? 0) - (b.order ?? 0))
  store.set('categories', categories)
  if (supabase) {
    const { agentId } = store.get('settings')
    const rows = categories.map(c => ({ id: c.id, agent_id: agentId, name: c.name, order: c.order }))
    supabase.from('categories').upsert(rows)
      .then(({ error }) => { if (error) console.error('[Supabase] categories reorder:', error.message) })
  }
  return categories
})

// ── Execute ───────────────────────────────────────────────────────────────────
ipcMain.handle('button:execute', async (_, buttonId) => {
  try {
    await executeButtonById(buttonId)
    return { ok: true }
  } catch (e) {
    return { ok: false, error: e.message }
  }
})

// ── Coordinate capture ────────────────────────────────────────────────────────
ipcMain.handle('capture:start', (_, buttonId) => {
  pendingCaptureId = buttonId
  const { bounds } = screen.getPrimaryDisplay()
  overlayWindow.setBounds(bounds)
  mainWindow.minimize()
  setTimeout(() => {
    overlayWindow.show()
    overlayWindow.focus()
    overlayWindow.webContents.send('overlay:activate')
  }, 280)
})

ipcMain.handle('capture:submit', (_, coords) => {
  overlayWindow.hide()
  setTimeout(() => {
    mainWindow.restore()
    mainWindow.focus()
    mainWindow.webContents.send('capture:result', { x: coords.x, y: coords.y, buttonId: pendingCaptureId })
    pendingCaptureId = null
  }, 120)
})

ipcMain.handle('capture:cancel', () => {
  overlayWindow.hide()
  pendingCaptureId = null
  setTimeout(() => { mainWindow.restore(); mainWindow.focus() }, 120)
})

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
    // Hide the window so it doesn't appear in the capture
    mainWindow.minimize()
    await new Promise(r => setTimeout(r, 400))
    const color = await pixelMonitor.sampleRegion(pm.region)
    mainWindow.restore()
    mainWindow.focus()
    if (!color) return { ok: false, error: 'Capture returned no pixels' }
    const calibration = { ...pm.calibration, [state]: color }
    store.set('pixelMonitor', { ...pm, calibration })
    syncPixelMonitor()
    return { ok: true, color }
  } catch (e) {
    mainWindow.restore()
    mainWindow.focus()
    return { ok: false, error: e.message }
  }
})

ipcMain.handle('pixelMonitor:getStatus', () => ({ status: currentCallStatus }))

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

// ── Window controls ───────────────────────────────────────────────────────────
ipcMain.handle('window:minimize', () => mainWindow.minimize())
ipcMain.handle('window:maximize', () => {
  mainWindow.isMaximized() ? mainWindow.unmaximize() : mainWindow.maximize()
})
ipcMain.handle('window:close', () => app.quit())
