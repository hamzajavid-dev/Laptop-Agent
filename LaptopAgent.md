# Laptop Agent — Electron Desktop App

## Purpose

Runs on the CSR's Windows machine. Listens for commands from Supabase, physically clicks buttons on the softphone dialer using screen coordinates, and monitors the call status via pixel color detection.

## Tech Stack

| Layer | Technology |
|---|---|
| Shell | Electron (frameless window) |
| Renderer | React + Vite |
| Styling | Tailwind CSS |
| Storage | `electron-store` (local JSON) |
| Backend | Supabase JS client |
| Click execution | PowerShell `mouse_event` via `execFile` |

## Project Structure

```
src/
  main/
    index.js          — Electron main process (IPC, Supabase, PixelMonitor, click engine)
    pixelMonitor.js   — Pixel color sampling helper (inlined into index.js to avoid Rollup issues)
  preload/
    index.js          — Context bridge — exposes window.api to renderer
  renderer/src/
    App.jsx           — Root; routes to Overlay or MainLayout based on ?mode=overlay
    components/
      MainLayout.jsx  — Main app shell, state management, execute logic
      ButtonList.jsx  — Left sidebar: grouped button list
      ButtonEditor.jsx— Right panel: create/edit a button
      CategoriesPanel.jsx — Modal: manage categories
      Settings.jsx    — Modal: Supabase credentials + Agent ID
      TitleBar.jsx    — Custom frameless title bar with window controls
      Overlay.jsx     — Transparent fullscreen window for coordinate capture
```

## Key Flows

### Button Execution (local)
1. User clicks Play on a button card in `ButtonList`
2. `MainLayout.handleExecute` calls `window.api.executeButton(id)`
3. Main process runs PowerShell to move cursor + fire `mouse_event`

### Command Execution (remote, from supervisor)
1. Supabase Realtime fires INSERT event on `commands` table
2. `handleCommand` in main process calls `executeButtonById`
3. Updates command row to `done` or `error`
4. Sends `command:incoming` and `command:result` IPC events to renderer for toast display

### Disposition Flow
- Buttons in the **Disposition** category are filtered out of the normal button list
- When any button whose **category** contains "hung up" or "hang up" (case-insensitive) is executed, `showDisposition` state becomes `true`
- The sidebar switches to show only Disposition buttons
- Clicking a Disposition button executes it **twice** then resets `showDisposition` to `false`

### Coordinate Capture
1. User clicks "Capture" in ButtonEditor
2. Main window minimizes; transparent overlay window expands to full screen
3. User clicks on screen → `screenX/screenY` sent back via IPC
4. Overlay hides; main window restores with coordinates populated

### Pixel Monitor (call status detection)
1. User configures a screen region in Settings → Pixel Monitor tab
2. User calibrates `live_call`, `hung_up`, `idle` color samples
3. Monitor polls at `intervalMs` (default 500 ms), averages region color, classifies against calibration with Euclidean distance + tolerance
4. Confirmed state changes (3 consecutive matching reads) are pushed to `agent_status` in Supabase

## IPC API (window.api)

Exposed via preload context bridge. All handlers are `ipcMain.handle` / `ipcRenderer.invoke` pairs.

| API Method | Description |
|---|---|
| `getButtons()` | Load all buttons from local store |
| `saveButton(button)` | Create or update a button (synced to Supabase) |
| `deleteButton(id)` | Delete a button (synced to Supabase) |
| `reorderButtons(category, ids)` | Reorder buttons within a category |
| `executeButton(id)` | Click the button's coordinates |
| `getCategories()` | Load all categories |
| `saveCategory(cat)` | Create or update a category |
| `deleteCategory(id)` | Delete a category |
| `reorderCategories(ids)` | Reorder categories |
| `getSettings()` / `saveSettings()` | Supabase credentials + agent ID |
| `startCapture(buttonId)` | Launch overlay for point coordinate capture |
| `submitCapture(coords)` | Submit captured point |
| `cancelCapture()` | Cancel point capture |
| `startRegionCapture()` | Launch overlay for region drag capture |
| `submitRegionCapture(region)` | Submit captured region |
| `cancelRegionCapture()` | Cancel region capture |
| `getPixelMonitorConfig()` | Load pixel monitor config |
| `savePixelMonitorConfig(patch)` | Update pixel monitor config |
| `calibratePixelMonitor(state)` | Sample current region color for a state |
| `getPixelMonitorStatus()` | Get current call status |
| `minimizeWindow` / `maximizeWindow` / `closeWindow` | Window controls |

## Local Storage

Stored via `electron-store` in the user's app data folder, file name `csr-agent.json`.

```json
{
  "buttons": [...],
  "categories": [...],
  "settings": { "supabaseUrl": "", "supabaseKey": "", "agentId": "" },
  "pixelMonitor": {
    "enabled": false,
    "region": null,
    "intervalMs": 500,
    "tolerance": 30,
    "calibration": { "live_call": null, "hung_up": null, "idle": null }
  }
}
```

## Running

```bash
cd "Laptop Agent"
npm install
npm run dev      # Vite + Electron in dev mode
npm run build    # Package for distribution
```
