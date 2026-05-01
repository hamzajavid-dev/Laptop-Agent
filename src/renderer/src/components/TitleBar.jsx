import { Minus, Square, X, Settings } from 'lucide-react'

export default function TitleBar({ onSettings, supabaseConnected }) {
  return (
    <div className="drag-region flex items-center h-10 bg-slate-900 border-b border-slate-800 px-4 flex-shrink-0">
      {/* App identity */}
      <div className="flex items-center gap-2">
        <div className="w-2.5 h-2.5 rounded-full bg-blue-500 shadow-lg shadow-blue-500/50" />
        <span className="text-sm font-semibold text-slate-200 tracking-wide">CSR Agent</span>
        <span className="text-xs text-slate-500 ml-1">v0.2</span>
      </div>

      {/* Supabase connection dot */}
      {supabaseConnected !== null && (
        <div className="flex items-center gap-1.5 ml-4">
          <div className={`w-1.5 h-1.5 rounded-full ${supabaseConnected ? 'bg-emerald-500' : 'bg-slate-600'}`} />
          <span className="text-xs text-slate-600">{supabaseConnected ? 'Synced' : 'Local'}</span>
        </div>
      )}

      <div className="flex-1" />

      {/* Settings + Window controls */}
      <div className="no-drag flex items-center gap-1">
        <button
          onClick={onSettings}
          className="w-7 h-7 flex items-center justify-center rounded text-slate-500 hover:text-slate-200 hover:bg-slate-700 transition-colors"
          title="Settings"
        >
          <Settings size={13} />
        </button>

        <div className="w-px h-4 bg-slate-800 mx-1" />

        <button
          onClick={() => window.api.minimize()}
          className="w-7 h-7 flex items-center justify-center rounded text-slate-500 hover:text-slate-200 hover:bg-slate-700 transition-colors"
        >
          <Minus size={13} />
        </button>
        <button
          onClick={() => window.api.maximize()}
          className="w-7 h-7 flex items-center justify-center rounded text-slate-500 hover:text-slate-200 hover:bg-slate-700 transition-colors"
        >
          <Square size={11} />
        </button>
        <button
          onClick={() => window.api.close()}
          className="w-7 h-7 flex items-center justify-center rounded text-slate-500 hover:text-white hover:bg-red-600 transition-colors"
        >
          <X size={13} />
        </button>
      </div>
    </div>
  )
}
