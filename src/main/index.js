const { app, BrowserWindow, ipcMain, screen } = require('electron')
const { join } = require('path')
const { randomUUID } = require('crypto')
const { execFile } = require('child_process')
const Store = require('electron-store')
const { createClient } = require('@supabase/supabase-js')

// ── Persistent store ─────────────────────────────────────────────────────────
const store = new Store({
  name: 'csr-agent',
  defaults: {
    buttons: [],
    categories: [],
    settings: { supabaseUrl: '', supabaseKey: '', agentId: '' }
  }
})

// ── App state ────────────────────────────────────────────────────────────────
let mainWindow = null
let overlayWindow = null
let pendingCaptureId = null
let supabase = null
let realtimeChannel = null
let pollInterval = null
const executingIds = new Set()

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
    await pushAllButtonsToSupabase()
    if (agentId) startRealtimeListener(agentId)
    mainWindow?.webContents.send('supabase:status', { connected: true })
  } catch (e) {
    console.error('[Supabase] init failed:', e.message)
    supabase = null
    mainWindow?.webContents.send('supabase:status', { connected: false, error: e.message })
  }
}

async function pushAllButtonsToSupabase() {
  if (!supabase) return
  const { agentId } = store.get('settings')
  const buttons = store.get('buttons')
  const categories = store.get('categories')

  if (buttons.length) {
    const rows = buttons.map(b => {
      const row = {
        id: b.id,
        agent_id: agentId,
        name: b.name,
        category: b.category || '',
        type: b.type || 'call_control',
        coordinates: b.coordinates || null,
        active: b.active ?? true,
        order: b.order ?? 0,
        created_at: b.createdAt || new Date().toISOString(),
        updated_at: new Date().toISOString()
      }
      if (b.color) row.color = b.color
      return row
    })
    const { error } = await supabase.from('buttons').upsert(rows)
    if (error) console.error('[Supabase] bulk button sync error:', error.message)
  }

  if (categories.length) {
    const rows = categories.map(c => ({
      id: c.id,
      agent_id: agentId,
      name: c.name,
      order: c.order ?? 0
    }))
    const { error } = await supabase.from('categories').upsert(rows)
    if (error) console.error('[Supabase] bulk category sync error:', error.message)
  }
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
        type: saved.type || 'call_control',
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

// ── Window controls ───────────────────────────────────────────────────────────
ipcMain.handle('window:minimize', () => mainWindow.minimize())
ipcMain.handle('window:maximize', () => {
  mainWindow.isMaximized() ? mainWindow.unmaximize() : mainWindow.maximize()
})
ipcMain.handle('window:close', () => app.quit())
