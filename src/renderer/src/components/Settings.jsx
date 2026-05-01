import { useState, useEffect } from 'react'
import { X, Eye, EyeOff, CheckCircle2, XCircle, Loader2, Wifi } from 'lucide-react'

export default function Settings({ onClose }) {
  const [form, setForm] = useState({ supabaseUrl: '', supabaseKey: '', agentId: '' })
  const [showKey, setShowKey] = useState(false)
  const [testState, setTestState] = useState(null) // null | 'testing' | 'ok' | 'error'
  const [testError, setTestError] = useState('')
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    window.api.getSettings().then(s => { if (s) setForm(s) })
  }, [])

  const handleTest = async () => {
    if (!form.supabaseUrl || !form.supabaseKey) return
    setTestState('testing')
    setTestError('')
    const result = await window.api.testSupabase({ supabaseUrl: form.supabaseUrl, supabaseKey: form.supabaseKey })
    setTestState(result.ok ? 'ok' : 'error')
    if (!result.ok) setTestError(result.error || 'Connection failed')
  }

  const handleSave = async () => {
    setSaving(true)
    await window.api.saveSettings(form)
    setSaving(false)
    onClose()
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
          <button
            onClick={() => setShowKey(v => !v)}
            className="absolute right-2.5 top-1/2 -translate-y-1/2 text-slate-500 hover:text-slate-300"
          >
            {showKey ? <EyeOff size={14} /> : <Eye size={14} />}
          </button>
        )}
      </div>
      {opts.hint && <p className="text-xs text-slate-600 mt-1">{opts.hint}</p>}
    </div>
  )

  return (
    <div className="absolute inset-0 z-50 flex items-center justify-center bg-slate-950/80 backdrop-blur-sm">
      <div className="bg-slate-900 border border-slate-700/60 rounded-2xl w-full max-w-md mx-4 shadow-2xl shadow-black/60">
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-slate-800">
          <div className="flex items-center gap-2.5">
            <div className="w-7 h-7 rounded-lg bg-blue-500/15 border border-blue-500/25 flex items-center justify-center">
              <Wifi size={13} className="text-blue-400" />
            </div>
            <span className="text-sm font-semibold text-slate-200">Settings</span>
          </div>
          <button
            onClick={onClose}
            className="w-7 h-7 flex items-center justify-center rounded-lg text-slate-500 hover:text-slate-200 hover:bg-slate-800 transition-colors"
          >
            <X size={14} />
          </button>
        </div>

        {/* Body */}
        <div className="px-6 py-5 space-y-4">
          <p className="text-xs text-slate-500 -mt-1">
            Connect to Supabase to sync buttons and receive remote click commands from your dashboard.
          </p>

          {field('Project URL', 'supabaseUrl', { placeholder: 'https://xxxx.supabase.co' })}
          {field('Anon / Service Key', 'supabaseKey', { password: true, placeholder: 'eyJhbGci...' })}
          {field('Agent ID', 'agentId', {
            placeholder: 'agent-001',
            hint: 'Unique ID for this machine — used to route commands to the right agent.'
          })}

          {/* Test connection */}
          <div className="flex items-center gap-3 pt-1">
            <button
              onClick={handleTest}
              disabled={!form.supabaseUrl || !form.supabaseKey || testState === 'testing'}
              className="flex items-center gap-1.5 text-xs font-medium px-3 py-1.5 rounded-lg border border-slate-700 text-slate-300 hover:border-slate-500 hover:text-white disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
            >
              {testState === 'testing' ? <Loader2 size={12} className="animate-spin" /> : <Wifi size={12} />}
              Test Connection
            </button>

            {testState === 'ok' && (
              <div className="flex items-center gap-1.5 text-xs text-emerald-400">
                <CheckCircle2 size={13} />
                Connected
              </div>
            )}
            {testState === 'error' && (
              <div className="flex items-center gap-1.5 text-xs text-rose-400">
                <XCircle size={13} />
                {testError || 'Failed'}
              </div>
            )}
          </div>
        </div>

        {/* Footer */}
        <div className="flex items-center justify-end gap-2 px-6 py-4 border-t border-slate-800">
          <button
            onClick={onClose}
            className="px-4 py-2 text-sm text-slate-400 hover:text-slate-200 transition-colors"
          >
            Cancel
          </button>
          <button
            onClick={handleSave}
            disabled={saving}
            className="flex items-center gap-1.5 px-4 py-2 bg-blue-600 hover:bg-blue-500 disabled:opacity-60 text-white text-sm font-medium rounded-lg transition-colors"
          >
            {saving && <Loader2 size={13} className="animate-spin" />}
            Save Settings
          </button>
        </div>
      </div>
    </div>
  )
}
