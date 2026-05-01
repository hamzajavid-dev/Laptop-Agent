import { Plus, Pencil, Trash2, MapPin, Play, GripVertical, FolderKanban, ArrowUp, ArrowDown } from 'lucide-react'


export default function ButtonList({ buttons, categories, editingId, onNew, onManageCategories, onEdit, onDelete, onExecute, onMove }) {
  const grouped = groupButtons(buttons, categories)

  return (
    <aside className="w-80 flex flex-col bg-slate-900 border-r border-slate-800 flex-shrink-0">
      <div className="flex items-center justify-between px-4 py-3 border-b border-slate-800">
        <div className="flex items-center gap-2">
          <span className="text-sm font-semibold text-slate-200">Buttons</span>
          {buttons.length > 0 && <span className="text-xs bg-slate-700 text-slate-400 rounded-full px-2 py-0.5">{buttons.length}</span>}
        </div>
        <div className="flex items-center gap-2">
          <button onClick={onManageCategories} className="text-xs px-2.5 py-1.5 rounded-md border border-slate-700 text-slate-300 hover:bg-slate-800 flex items-center gap-1">
            <FolderKanban size={13} />
            Categories
          </button>
          <button onClick={onNew} className="flex items-center gap-1.5 text-xs font-medium text-blue-400 hover:text-blue-300 bg-blue-500/10 hover:bg-blue-500/20 border border-blue-500/20 rounded-md px-2.5 py-1.5 transition-colors">
            <Plus size={13} />
            New
          </button>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto py-2 px-2 space-y-3">
        {grouped.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-40 text-center px-4">
            <MapPin size={24} className="text-slate-700 mb-2" />
            <p className="text-slate-600 text-xs">No buttons yet.</p>
            <p className="text-slate-700 text-xs">Click New to create one.</p>
          </div>
        ) : (
          grouped.map(group => (
            <section key={group.categoryId || group.name}>
              <h3 className="text-xs uppercase tracking-wider text-slate-500 mb-2 px-1">{group.name}</h3>
              <div className="space-y-1.5">
                {group.buttons.map((btn, idx) => (
                  <ButtonCard
                    key={btn.id}
                    button={btn}
                    isEditing={btn.id === editingId}
                    canMoveUp={idx > 0}
                    canMoveDown={idx < group.buttons.length - 1}
                    onMoveUp={() => onMove(btn, -1)}
                    onMoveDown={() => onMove(btn, 1)}
                    onEdit={onEdit}
                    onDelete={onDelete}
                    onExecute={onExecute}
                  />
                ))}
              </div>
            </section>
          ))
        )}
      </div>
    </aside>
  )
}

function groupButtons(buttons, categories) {
  const catMap = new Map(categories.map(c => [c.name, c]))
  const groups = new Map()

  for (const b of buttons) {
    const name = b.category || 'General'
    if (!groups.has(name)) groups.set(name, [])
    groups.get(name).push(b)
  }

  const out = [...groups.entries()].map(([name, list]) => {
    const cat = catMap.get(name)
    return {
      name,
      categoryId: cat?.id || null,
      categoryOrder: cat?.order ?? Number.MAX_SAFE_INTEGER,
      buttons: [...list].sort((a, b) => (a.order ?? 0) - (b.order ?? 0))
    }
  })

  return out.sort((a, b) => a.categoryOrder - b.categoryOrder || a.name.localeCompare(b.name))
}

function ButtonCard({ button, isEditing, onEdit, onDelete, onExecute, canMoveUp, canMoveDown, onMoveUp, onMoveDown }) {
  const dotColor = button.color || null

  return (
    <div className={`group relative rounded-lg border px-3 py-2.5 cursor-pointer transition-all ${isEditing ? 'bg-blue-500/10 border-blue-500/40' : 'bg-slate-800/50 border-slate-700/50 hover:bg-slate-800 hover:border-slate-600'}`} onClick={() => onEdit(button)}>
      <div className="flex items-start gap-2.5">
        <GripVertical size={14} className="text-slate-600 mt-1" />
        <div
          className={`w-2 h-2 rounded-full mt-1.5 flex-shrink-0 ${!dotColor ? 'bg-slate-500' : ''}`}
          style={dotColor ? { backgroundColor: dotColor } : {}}
        />
        <div className="flex-1 min-w-0">
          <p className="text-sm font-medium text-slate-200 truncate">{button.name || 'Unnamed'}</p>
          {button.category && <span className="text-xs text-slate-500 truncate">{button.category}</span>}
          {button.coordinates ? <p className="text-xs text-slate-500 mt-1 font-mono">X: {button.coordinates.x} Y: {button.coordinates.y}</p> : <p className="text-xs text-slate-700 mt-1 italic">No coordinates</p>}
        </div>

        <div className="flex gap-1 opacity-0 group-hover:opacity-100 transition-opacity flex-shrink-0">
          <button onClick={e => { e.stopPropagation(); onMoveUp() }} disabled={!canMoveUp} className="w-6 h-6 flex items-center justify-center rounded text-slate-500 hover:text-blue-400 hover:bg-blue-500/10 disabled:opacity-30"><ArrowUp size={11} /></button>
          <button onClick={e => { e.stopPropagation(); onMoveDown() }} disabled={!canMoveDown} className="w-6 h-6 flex items-center justify-center rounded text-slate-500 hover:text-blue-400 hover:bg-blue-500/10 disabled:opacity-30"><ArrowDown size={11} /></button>
          {button.coordinates && button.active && <button onClick={e => { e.stopPropagation(); onExecute(button.id) }} className="w-6 h-6 flex items-center justify-center rounded text-slate-500 hover:text-emerald-400 hover:bg-emerald-500/10"><Play size={11} /></button>}
          <button onClick={e => { e.stopPropagation(); onEdit(button) }} className="w-6 h-6 flex items-center justify-center rounded text-slate-500 hover:text-blue-400 hover:bg-blue-500/10"><Pencil size={12} /></button>
          <button onClick={e => { e.stopPropagation(); onDelete(button.id) }} className="w-6 h-6 flex items-center justify-center rounded text-slate-500 hover:text-rose-400 hover:bg-rose-500/10"><Trash2 size={12} /></button>
        </div>
      </div>
    </div>
  )
}
