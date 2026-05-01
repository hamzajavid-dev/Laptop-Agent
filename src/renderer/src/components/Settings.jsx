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
