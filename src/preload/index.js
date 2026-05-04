const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('api', {
  // --- Buttons ---
  getButtons: () => ipcRenderer.invoke('buttons:getAll'),
  saveButton: (button) => ipcRenderer.invoke('buttons:save', button),
  deleteButton: (id) => ipcRenderer.invoke('buttons:delete', id),
  reorderButtons: (category, orderedIds) => ipcRenderer.invoke('buttons:reorder', { category, orderedIds }),

  // --- Categories ---
  getCategories: () => ipcRenderer.invoke('categories:getAll'),
  saveCategory: (category) => ipcRenderer.invoke('categories:save', category),
  deleteCategory: (id) => ipcRenderer.invoke('categories:delete', id),
  reorderCategories: (orderedIds) => ipcRenderer.invoke('categories:reorder', orderedIds),

  // --- Execute ---
  executeButton: (buttonId) => ipcRenderer.invoke('button:execute', buttonId),

  // --- Coordinate capture ---
  startCapture: (buttonId) => ipcRenderer.invoke('capture:start', buttonId),
  submitCapture: (coords) => ipcRenderer.invoke('capture:submit', coords),
  cancelCapture: () => ipcRenderer.invoke('capture:cancel'),

  // --- Settings ---
  getSettings: () => ipcRenderer.invoke('settings:get'),
  saveSettings: (settings) => ipcRenderer.invoke('settings:save', settings),
  testSupabase: (creds) => ipcRenderer.invoke('settings:test', creds),

  // --- Events (each returns a cleanup fn) ---
  onCaptureResult: (cb) => {
    const h = (_, d) => cb(d)
    ipcRenderer.on('capture:result', h)
    return () => ipcRenderer.off('capture:result', h)
  },
  onOverlayActivate: (cb) => {
    const h = () => cb()
    ipcRenderer.on('overlay:activate', h)
    return () => ipcRenderer.off('overlay:activate', h)
  },
  onSupabaseStatus: (cb) => {
    const h = (_, d) => cb(d)
    ipcRenderer.on('supabase:status', h)
    return () => ipcRenderer.off('supabase:status', h)
  },
  onButtonsSynced: (cb) => {
    const h = (_, d) => cb(d)
    ipcRenderer.on('buttons:synced', h)
    return () => ipcRenderer.off('buttons:synced', h)
  },
  onCommandIncoming: (cb) => {
    const h = (_, d) => cb(d)
    ipcRenderer.on('command:incoming', h)
    return () => ipcRenderer.off('command:incoming', h)
  },
  onCommandResult: (cb) => {
    const h = (_, d) => cb(d)
    ipcRenderer.on('command:result', h)
    return () => ipcRenderer.off('command:result', h)
  },

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

  // --- Window controls ---
  minimize: () => ipcRenderer.invoke('window:minimize'),
  maximize: () => ipcRenderer.invoke('window:maximize'),
  close: () => ipcRenderer.invoke('window:close')
})
