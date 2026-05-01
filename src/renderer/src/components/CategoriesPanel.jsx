import { useState } from 'react'
import { X, Plus, Trash2, ChevronUp, ChevronDown, Tag } from 'lucide-react'

export default function CategoriesPanel({ categories, onClose, onChange }) {
  const [newName, setNewName] = useState('')

  const sorted = [...categories].sort((a, b) => (a.order ?? 0) - (b.order ?? 0))

  const handleAdd = async () => {
    const name = newName.trim()
    if (!name || categories.some(c => c.name.toLowerCase() === name.toLowerCase())) return
    const updated = await window.api.saveCategory({ name })
    onChange(updated)
    setNewName('')
  }

  const handleDelete = async (id) => {
    const updated = await window.api.deleteCategory(id)
    onChange(updated)
  }

  const move = async (index, dir) => {
    const reordered = [...sorted]
    const swapIdx = index + dir
    if (swapIdx < 0 || swapIdx >= reordered.length) return
    ;[reordered[index], reordered[swapIdx]] = [reordered[swapIdx], reordered[index]]
    const updated = await window.api.reorderCategories(reordered.map(c => c.id))
    onChange(updated)
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
      <div className="bg-slate-900 border border-slate-700 rounded-2xl w-[420px] max-h-[80vh] flex flex-col shadow-2xl shadow-black/60">
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-slate-800">
          <div className="flex items-center gap-2.5">
            <Tag size={16} className="text-blue-400" />
            <h2 className="text-sm font-semibold text-slate-100">Manage Categories</h2>
          </div>
          <button onClick={onClose} className="w-7 h-7 flex items-center justify-center rounded-lg text-slate-500 hover:text-slate-200 hover:bg-slate-800 transition-colors">
            <X size={15} />
          </button>
        </div>

        {/* Category list */}
        <div className="flex-1 overflow-y-auto py-2 px-3 space-y-1">
          {sorted.length === 0 && (
            <div className="flex flex-col items-center justify-center h-24 text-slate-600 text-xs">
              No categories yet. Add one below.
            </div>
          )}
          {sorted.map((cat, idx) => (
            <div key={cat.id} className="flex items-center gap-2 px-3 py-2.5 rounded-lg bg-slate-800/60 border border-slate-700/50 group">
              {/* Order badge */}
              <span className="text-xs text-slate-600 font-mono w-4 shrink-0">{idx + 1}</span>

              <span className="flex-1 text-sm text-slate-200 truncate">{cat.name}</span>

              {/* Up / Down */}
              <div className="flex gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity">
                <button
                  onClick={() => move(idx, -1)}
                  disabled={idx === 0}
                  className="w-6 h-6 flex items-center justify-center rounded text-slate-500 hover:text-blue-400 hover:bg-blue-500/10 disabled:opacity-30 disabled:cursor-default transition-colors"
                >
                  <ChevronUp size={13} />
                </button>
                <button
                  onClick={() => move(idx, 1)}
                  disabled={idx === sorted.length - 1}
                  className="w-6 h-6 flex items-center justify-center rounded text-slate-500 hover:text-blue-400 hover:bg-blue-500/10 disabled:opacity-30 disabled:cursor-default transition-colors"
                >
                  <ChevronDown size={13} />
                </button>
              </div>

              {/* Delete */}
              <button
                onClick={() => handleDelete(cat.id)}
                className="w-6 h-6 flex items-center justify-center rounded text-slate-600 hover:text-rose-400 hover:bg-rose-500/10 opacity-0 group-hover:opacity-100 transition-all"
              >
                <Trash2 size={12} />
              </button>
            </div>
          ))}
        </div>

        {/* Add new */}
        <div className="flex gap-2 px-4 py-4 border-t border-slate-800">
          <input
            type="text"
            value={newName}
            onChange={e => setNewName(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && handleAdd()}
            placeholder="New category name…"
            className="flex-1 bg-slate-800 border border-slate-700 text-slate-200 rounded-lg px-3 py-2 text-sm placeholder:text-slate-600 focus:outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500/30 transition-colors"
          />
          <button
            onClick={handleAdd}
            disabled={!newName.trim()}
            className="flex items-center gap-1.5 px-3 py-2 rounded-lg text-sm font-medium bg-blue-600 hover:bg-blue-500 text-white transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
          >
            <Plus size={14} />
            Add
          </button>
        </div>
      </div>
    </div>
  )
}
