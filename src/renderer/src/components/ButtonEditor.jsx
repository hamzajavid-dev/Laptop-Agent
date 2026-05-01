import { Crosshair, Save, X, ToggleLeft, ToggleRight } from 'lucide-react'

const COLOR_PALETTE = [
  { label: 'Default', value: null },
  { label: 'Red', value: '#ef4444' },
  { label: 'Orange', value: '#f97316' },
  { label: 'Amber', value: '#f59e0b' },
  { label: 'Green', value: '#22c55e' },
  { label: 'Teal', value: '#14b8a6' },
  { label: 'Blue', value: '#3b82f6' },
  { label: 'Indigo', value: '#6366f1' },
  { label: 'Purple', value: '#a855f7' },
  { label: 'Pink', value: '#ec4899' },
  { label: 'Rose', value: '#f43f5e' },
]

export default function ButtonEditor({ button, categories, onChange, onSave, onCancel }) {
  const isNew = !button.id
  const hasCoords = !!button.coordinates
  const set = (field, value) => onChange(prev => ({ ...prev, [field]: value }))

  const handleCapture = () => window.api.startCapture(button.id || 'new')
  const handleSave = () => {
    if (!button.name.trim()) return
    onSave(button)
  }

  const selectedColor = button.color ?? null

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center justify-between px-6 py-4 border-b border-slate-800 flex-shrink-0">
        <div>
          <h2 className="text-base font-semibold text-slate-100">{isNew ? 'Create Button' : 'Edit Button'}</h2>
          <p className="text-xs text-slate-500 mt-0.5">{isNew ? 'Define a new dialer action button' : `ID: ${button.id?.slice(0, 8)}...`}</p>
        </div>
        <button onClick={() => set('active', !button.active)} className="flex items-center gap-2 text-sm">
          {button.active ? <><ToggleRight size={22} className="text-emerald-500" /><span className="text-emerald-400 text-xs font-medium">Active</span></> : <><ToggleLeft size={22} className="text-slate-600" /><span className="text-slate-500 text-xs">Inactive</span></>}
        </button>
      </div>

      <div className="flex-1 overflow-y-auto px-6 py-5 space-y-5">
        <Field label="Button Name" required>
          <input type="text" value={button.name} onChange={e => set('name', e.target.value)} placeholder="e.g. Hangup Call" className={inputClass} />
        </Field>

        <Field label="Category">
          <select value={button.category || ''} onChange={e => set('category', e.target.value)} className={inputClass}>
            <option value="">General</option>
            {categories.map(c => <option key={c.id} value={c.name}>{c.name}</option>)}
          </select>
        </Field>

        <Field label="Button Color">
          <div className="flex flex-wrap gap-2">
            {COLOR_PALETTE.map(c => (
              <button
                key={c.label}
                title={c.label}
                onClick={() => set('color', c.value)}
                className={`w-7 h-7 rounded-full border-2 transition-all ${selectedColor === c.value ? 'border-blue-400 scale-110' : 'border-transparent hover:border-slate-500'}`}
                style={c.value ? { backgroundColor: c.value } : { background: 'conic-gradient(from 0deg, #ef4444, #f97316, #f59e0b, #22c55e, #3b82f6, #a855f7, #ef4444)' }}
              >
                {c.value === null && selectedColor === null && (
                  <span className="text-white text-xs font-bold">✕</span>
                )}
              </button>
            ))}
          </div>
          <p className="text-xs text-slate-500 mt-1">
            {selectedColor ? <span>Selected: <span className="font-mono">{selectedColor}</span></span> : 'Default color (based on type)'}
          </p>
        </Field>

        <Field label="Screen Coordinates">
          <div className="space-y-3">
            <div className="flex gap-3">
              <CoordBox label="X" value={button.coordinates?.x} />
              <CoordBox label="Y" value={button.coordinates?.y} />
            </div>
            <button onClick={handleCapture} className="flex items-center gap-2 w-full justify-center py-2.5 rounded-lg border border-dashed border-slate-600 text-slate-400 hover:border-blue-500 hover:text-blue-400 hover:bg-blue-500/5 transition-all text-sm font-medium">
              <Crosshair size={15} />{hasCoords ? 'Re-capture Coordinate' : 'Capture Coordinate'}
            </button>
          </div>
        </Field>
      </div>

      <div className="flex items-center justify-end gap-3 px-6 py-4 border-t border-slate-800 flex-shrink-0">
        <button onClick={onCancel} className="flex items-center gap-1.5 px-4 py-2 rounded-lg text-sm text-slate-400 hover:text-slate-200 hover:bg-slate-800 transition-colors"><X size={14} />Cancel</button>
        <button onClick={handleSave} disabled={!button.name.trim()} className="flex items-center gap-1.5 px-5 py-2 rounded-lg text-sm font-medium bg-blue-600 hover:bg-blue-500 text-white transition-colors disabled:opacity-40 disabled:cursor-not-allowed"><Save size={14} />{isNew ? 'Create Button' : 'Save Changes'}</button>
      </div>
    </div>
  )
}

function Field({ label, required, children }) {
  return <div className="space-y-1.5"><label className="text-xs font-medium text-slate-400 uppercase tracking-wider">{label}{required && <span className="text-rose-500 ml-1">*</span>}</label>{children}</div>
}
function CoordBox({ label, value }) {
  return <div className="flex-1 bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 flex items-center gap-2"><span className="text-xs font-bold text-slate-500">{label}</span><span className="text-sm font-mono text-slate-200 flex-1 text-right">{value !== undefined && value !== null ? value : '-'}</span></div>
}

const inputClass = 'w-full bg-slate-800 border border-slate-700 text-slate-200 rounded-lg px-3 py-2.5 text-sm placeholder:text-slate-600 focus:outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500/30 transition-colors'
