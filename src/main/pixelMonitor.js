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
