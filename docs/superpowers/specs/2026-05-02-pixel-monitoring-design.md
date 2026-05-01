# Pixel Monitoring — Design Spec
**Date:** 2026-05-02
**Branch:** `feature/pixel-monitoring` (Laptop Agent), separate branch for Web App

---

## Overview

Add a Pixel Monitoring mode to the Electron laptop agent that continuously reads a user-selected screen region, detects VICIdial call status from dominant pixel color, and syncs that status in real time to Supabase so the web dashboard can display it live.

---

## Architecture & Data Flow

```
Electron Main Process
  └── PixelMonitor module (setInterval @ 500–1000ms)
        ├── desktopCapturer → full screenshot → crop to saved region → avg RGB
        ├── compare RGB vs. calibrated colors (Euclidean distance + tolerance)
        ├── debounce: 3 consistent readings required before confirming state change
        ├── on confirmed change → upsert `agent_status` row in Supabase
        └── IPC event → renderer updates status badge immediately

Supabase `agent_status` table
  └── Realtime UPDATE subscription (web app)
        └── CallStatusBadge component updates live
```

---

## Supabase Schema

New table `agent_status`:

```sql
create table agent_status (
  id         uuid primary key default gen_random_uuid(),
  agent_id   text not null unique,
  status     text not null default 'idle', -- 'live_call' | 'hung_up' | 'idle'
  updated_at timestamptz not null default now()
);
```

One row per agent. Upserted (not inserted) on every confirmed status change using `agent_id` as the conflict key. The webapp subscribes to `UPDATE` events on this table filtered by `agent_id`.

---

## Laptop Agent — New Components

### 1. `src/main/pixelMonitor.js`

Self-contained module. Exports: `start(config)`, `stop()`, `sampleRegion(region)` (one-shot, used for calibration).

**Config shape:**
```js
{
  region: { x, y, width, height },   // screen coordinates
  calibration: {
    live_call: { r, g, b },
    hung_up:   { r, g, b },
    idle:      { r, g, b }
  },
  intervalMs: 500,                    // 500 | 750 | 1000
  tolerance: 30,                      // Euclidean RGB distance threshold
  debounceCount: 3                    // readings that must agree before state change
}
```

**Loop logic per tick:**
1. Call `desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: screenW, height: screenH } })`
2. Get `NativeImage` thumbnail, call `.crop(region)`, then `.toBitmap()` for raw RGBA bytes
3. Compute average R, G, B across all pixels in the crop
4. For each calibrated state, compute Euclidean distance: `sqrt((r-cr)²+(g-cg)²+(b-cb)²)`
5. Pick the state with the smallest distance; if that distance > tolerance, result is `'idle'` (ambiguous)
6. Push result into a ring buffer of last `debounceCount` readings
7. If all readings in the buffer agree on a state AND it differs from the last confirmed state → emit change

**On state change:**
- Call `mainWindow.webContents.send('pixelMonitor:status', { status })` → renderer badge updates
- Upsert Supabase `agent_status` row: `{ agent_id, status, updated_at: now() }`

**CPU minimization:**
- Only capture when monitoring is enabled
- Use `thumbnailSize` matching the actual screen resolution (no upscaling)
- The crop + RGB average runs synchronously in <1ms for small regions

### 2. Region Selection (Overlay extension)

The existing `Overlay.jsx` and overlay window gain a second mode: `region-select`.

**Flow:**
1. User clicks "Select Region" in Settings → main process sends `overlay:activateRegion` IPC to overlay
2. Overlay enters region-select mode: shows a crosshair cursor and a live rubber-band rectangle as user drags
3. On `mouseup`: overlay sends `capture:submitRegion({ x, y, width, height })` to main
4. Main hides overlay, restores main window, stores region in `electron-store` under `pixelMonitor.region`

The overlay already handles `mousedown`/`mousemove`/`mouseup` for single-point capture — region select extends this with a drag state.

### 3. Calibration Flow

In the Settings panel, under the new "Pixel Monitoring" section, three buttons:
- **Calibrate Live Call** (green label)
- **Calibrate Hung Up** (red label)
- **Calibrate Idle** (slate label)

Each button triggers `pixelMonitor:calibrate` IPC with the state name. Main calls `sampleRegion(region)` (one-shot capture), stores the resulting `{ r, g, b }` in `electron-store` under `pixelMonitor.calibration[state]`. The UI shows a small color swatch next to each button reflecting the stored color.

A region must be selected before calibration buttons are enabled.

### 4. `electron-store` additions

Stored under `pixelMonitor` key (added to store defaults):
```js
pixelMonitor: {
  enabled: false,
  region: null,           // { x, y, width, height } | null
  intervalMs: 500,
  tolerance: 30,
  calibration: {
    live_call: null,      // { r, g, b } | null
    hung_up:   null,
    idle:      null
  }
}
```

### 5. IPC Surface (additions to preload)

| Channel | Direction | Payload |
|---|---|---|
| `pixelMonitor:getConfig` | renderer → main | — |
| `pixelMonitor:saveConfig` | renderer → main | `{ enabled, intervalMs, tolerance }` |
| `pixelMonitor:calibrate` | renderer → main | `{ state: 'live_call' \| 'hung_up' \| 'idle' }` |
| `pixelMonitor:status` | main → renderer | `{ status }` |
| `capture:startRegion` | renderer → main | — |
| `capture:submitRegion` | overlay → main | `{ x, y, width, height }` |
| `capture:resultRegion` | main → renderer | `{ x, y, width, height }` |

---

## Laptop Agent UI Changes

### TitleBar

Add a `CallStatusBadge` inline with the existing Supabase indicator. Only rendered when pixel monitoring is enabled.

```
● LIVE CALL    (emerald dot + text)
● HUNG UP      (rose dot + text)
● IDLE         (slate dot + text)
```

### Settings Panel — new "Pixel Monitoring" section

Layout (below existing Supabase fields, separated by a divider):

1. **Enable toggle** — on/off switch, disables the whole section when off
2. **Polling interval** — segmented control: 500ms / 750ms / 1s
3. **Tolerance** — number input (10–60, default 30)
4. **Select Region button** — opens overlay in region-select mode; shows saved region coords when set
5. **Calibration row** — three buttons (Live Call / Hung Up / Idle), each with a 12×12 color swatch showing the saved RGB
6. **Current status** — live readout of the last detected status (updated via IPC)

---

## Web App Changes

### New branch: `feature/pixel-monitoring` (Web App repo)

### `agent_status` Supabase type (added to `types.ts`)

```ts
export interface AgentStatus {
  id: string
  agent_id: string
  status: 'live_call' | 'hung_up' | 'idle'
  updated_at: string
}
```

### `CallStatusBadge` component (`src/components/CallStatusBadge.tsx`)

- On mount: fetches current `agent_status` row for `AGENT_ID`
- Subscribes to Supabase Realtime `UPDATE` on `agent_status` filtered by `agent_id`
- Polling fallback: re-fetches every 5s if Realtime drops
- Renders a compact pill in the Dashboard header:

```
● Live Call    (emerald)
● Hung Up      (rose)
● Idle         (slate-400)
● —            (slate-300, shown when no status row exists yet)
```

### Dashboard header change

Insert `<CallStatusBadge />` in the header's right-side flex group, between the wifi indicator and the Activity button. Small size — fits inline without layout changes.

---

## Error Handling & Edge Cases

| Case | Behavior |
|---|---|
| No region selected | Pixel monitoring cannot be enabled; toggle disabled |
| Not all 3 colors calibrated | Warning shown; monitoring can still run but uncalibrated states map to 'idle' |
| desktopCapturer returns no sources | Log warning, skip tick, do not change state |
| Supabase not connected | Status still updates in renderer via IPC; Supabase push skipped silently |
| UI layout changes (VICIdial update) | User clicks "Select Region" again to recalibrate region; calibration colors may also need redo |
| Monitoring disabled | setInterval cleared, no CPU usage, last known status badge hidden |

---

## Out of Scope

- OCR-based status detection
- Multiple region monitors
- Historical status logging / call duration tracking
- Automatic layout detection
