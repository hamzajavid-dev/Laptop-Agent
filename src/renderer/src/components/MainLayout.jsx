import { useState, useEffect, useCallback } from 'react'
import TitleBar from './TitleBar'
import ButtonList from './ButtonList'
import ButtonEditor from './ButtonEditor'
import Settings from './Settings'
import CategoriesPanel from './CategoriesPanel'
import { LayoutGrid, CheckCircle2, XCircle, Zap } from 'lucide-react'

const EMPTY_BUTTON = { id: null, name: '', category: '', type: 'call_control', coordinates: null, active: true }

export default function MainLayout() {
  const [buttons, setButtons] = useState([])
  const [categories, setCategories] = useState([])
  const [editing, setEditing] = useState(null)
  const [showSettings, setShowSettings] = useState(false)
  const [showCategories, setShowCategories] = useState(false)
  const [supabaseConnected, setSupabaseConnected] = useState(null)
  const [toast, setToast] = useState(null)

  const showToast = useCallback((message, type = 'ok') => {
    setToast({ message, type })
    setTimeout(() => setToast(null), 2500)
  }, [])

  useEffect(() => {
    window.api.getButtons().then(setButtons)
    window.api.getCategories().then(setCategories)
  }, [])

  useEffect(() => {
    const cleanups = [
      window.api.onCaptureResult((data) => setEditing(prev => prev ? { ...prev, coordinates: { x: data.x, y: data.y } } : prev)),
      window.api.onSupabaseStatus((data) => {
        setSupabaseConnected(data.connected)
        if (data.connected) showToast('Connected to Supabase', 'ok')
        else if (data.error) showToast('Supabase: ' + data.error, 'error')
      }),
      window.api.onCommandIncoming((data) => showToast(`Incoming: ${data.buttonName || data.buttonId}`, 'info')),
      window.api.onCommandResult((data) => data.status === 'done' ? showToast('Command executed', 'ok') : showToast('Execute failed: ' + (data.error || 'unknown'), 'error'))
    ]
    return () => cleanups.forEach(fn => fn())
  }, [showToast])

  const handleNew = () => setEditing({ ...EMPTY_BUTTON, category: categories[0]?.name || '' })
  const handleEdit = (btn) => setEditing({ ...btn })
  const handleChange = (updater) => setEditing(prev => typeof updater === 'function' ? updater(prev) : { ...prev, ...updater })

  const handleSave = async (button) => {
    const updated = await window.api.saveButton(button)
    setButtons(updated)
    setEditing(null)
  }

  const handleDelete = async (id) => {
    const updated = await window.api.deleteButton(id)
    setButtons(updated)
    if (editing?.id === id) setEditing(null)
  }

  const handleMove = async (button, dir) => {
    const same = buttons.filter(b => (b.category || '') === (button.category || '')).sort((a, b) => (a.order ?? 0) - (b.order ?? 0))
    const idx = same.findIndex(b => b.id === button.id)
    const swap = idx + dir
    if (idx < 0 || swap < 0 || swap >= same.length) return
    ;[same[idx], same[swap]] = [same[swap], same[idx]]
    const updated = await window.api.reorderButtons(button.category || '', same.map(b => b.id))
    setButtons(updated)
  }

  const handleExecute = async (buttonId) => {
    const btn = buttons.find(b => b.id === buttonId)
    showToast(`Clicking: ${btn?.name || ''}`, 'info')
    const result = await window.api.executeButton(buttonId)
    if (result.ok) showToast(`Clicked: ${btn?.name || ''}`, 'ok')
    else showToast('Click failed: ' + result.error, 'error')
  }

  return (
    <div className="flex flex-col h-full bg-slate-950 relative">
      <TitleBar onSettings={() => setShowSettings(true)} supabaseConnected={supabaseConnected} />
      <div className="flex flex-1 min-h-0">
        <ButtonList
          buttons={buttons}
          categories={categories}
          editingId={editing?.id}
          onNew={handleNew}
          onManageCategories={() => setShowCategories(true)}
          onEdit={handleEdit}
          onDelete={handleDelete}
          onExecute={handleExecute}
          onMove={handleMove}
        />

        <main className="flex-1 min-h-0 bg-slate-950 relative">
          {editing ? <ButtonEditor button={editing} categories={categories} onChange={handleChange} onSave={handleSave} onCancel={() => setEditing(null)} /> : <EmptyState onNew={handleNew} />}

          {toast && <div className={`absolute bottom-5 left-1/2 -translate-x-1/2 flex items-center gap-2 px-4 py-2.5 rounded-xl border text-sm font-medium shadow-lg shadow-black/40 pointer-events-none ${toast.type === 'ok' ? 'bg-emerald-900/80 border-emerald-700/50 text-emerald-300' : ''} ${toast.type === 'error' ? 'bg-rose-900/80 border-rose-700/50 text-rose-300' : ''} ${toast.type === 'info' ? 'bg-slate-800/90 border-slate-700/50 text-slate-300' : ''}`}>
            {toast.type === 'ok' && <CheckCircle2 size={14} />}
            {toast.type === 'error' && <XCircle size={14} />}
            {toast.type === 'info' && <Zap size={14} />}
            {toast.message}
          </div>}
        </main>
      </div>

      {showSettings && <Settings onClose={() => setShowSettings(false)} />}
      {showCategories && <CategoriesPanel categories={categories} onChange={setCategories} onClose={() => setShowCategories(false)} />}
    </div>
  )
}

function EmptyState({ onNew }) {
  return <div className="flex flex-col items-center justify-center h-full gap-5 text-center px-8"><div className="w-16 h-16 rounded-2xl bg-slate-800 border border-slate-700 flex items-center justify-center"><LayoutGrid size={28} className="text-slate-600" /></div><div><p className="text-slate-300 font-semibold text-base">No button selected</p><p className="text-slate-600 text-sm mt-1 max-w-xs">Create your first button to start capturing dialer coordinates</p></div><button onClick={onNew} className="px-5 py-2.5 bg-blue-600 hover:bg-blue-500 text-white text-sm font-medium rounded-lg transition-colors">+ New Button</button></div>
}
