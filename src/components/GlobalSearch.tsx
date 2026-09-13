import React, { useState, useEffect, useRef } from 'react';
import { Search, X, User, CheckSquare, Building2, Terminal } from 'lucide-react';
import { UserRecord, TaskRecord, ClientRecord } from '../types/database';

interface GlobalSearchProps {
  users: UserRecord[];
  tasks: TaskRecord[];
  clients: ClientRecord[];
}

export const GlobalSearch: React.FC<GlobalSearchProps> = ({ users, tasks, clients }) => {
  const [isOpen, setIsOpen] = useState(false);
  const [query, setQuery] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  // Toggle on Ctrl+K
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'k') {
        e.preventDefault();
        setIsOpen(true);
      }
      if (e.key === 'Escape') {
        setIsOpen(false);
      }
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, []);

  useEffect(() => {
    if (isOpen && inputRef.current) {
      setTimeout(() => inputRef.current?.focus(), 100);
    } else {
      setQuery('');
    }
  }, [isOpen]);

  if (!isOpen) return null;

  const searchQuery = query.toLowerCase();

  const filteredUsers = users.filter(u => u.name.toLowerCase().includes(searchQuery) || u.role.toLowerCase().includes(searchQuery));
  const filteredTasks = tasks.filter(t => t.title.toLowerCase().includes(searchQuery));
  const filteredClients = clients.filter(c => c.name.toLowerCase().includes(searchQuery));

  return (
    <div className="fixed inset-0 z-[100] flex items-start justify-center pt-[10vh] px-4">
      {/* Backdrop */}
      <div 
        className="absolute inset-0 bg-black/60 backdrop-blur-sm transition-opacity"
        onClick={() => setIsOpen(false)}
      />

      {/* Search Modal */}
      <div 
        className="relative w-full max-w-2xl rounded-2xl shadow-2xl overflow-hidden border border-white/10 animate-in fade-in zoom-in-95 duration-200"
        style={{ background: 'var(--gradient-card)' }}
        dir="rtl"
      >
        <div className="flex items-center gap-3 p-4 border-b border-white/10">
          <Search className="w-6 h-6 text-stone-400" />
          <input
            ref={inputRef}
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="ابحث عن مهام، عملاء، أو موظفين..."
            className="flex-1 bg-transparent border-none text-xl text-white focus:outline-none placeholder:text-stone-500"
          />
          <div className="flex items-center gap-2">
            <kbd className="hidden md:flex items-center justify-center px-2 py-1 rounded-md bg-white/5 border border-white/10 text-xs text-stone-400 font-sans">
              ESC
            </kbd>
            <button
              onClick={() => setIsOpen(false)}
              className="p-2 hover:bg-white/10 rounded-lg transition-colors text-stone-400 hover:text-white"
            >
              <X className="w-5 h-5" />
            </button>
          </div>
        </div>

        <div className="max-h-[60vh] overflow-y-auto custom-scrollbar p-2">
          {!query ? (
            <div className="p-8 text-center text-stone-500">
              <Terminal className="w-12 h-12 mx-auto mb-4 opacity-20" />
              <p>اكتب للبحث في جميع أقسام النظام</p>
            </div>
          ) : (
            <div className="space-y-4 p-2">
              {filteredTasks.length > 0 && (
                <div>
                  <h3 className="text-xs font-bold text-stone-400 mb-2 px-2 uppercase tracking-wider">المهام ({filteredTasks.length})</h3>
                  <div className="space-y-1">
                    {filteredTasks.slice(0, 5).map(task => (
                      <div key={task.id} className="flex items-center gap-3 p-3 rounded-xl hover:bg-white/5 cursor-pointer transition-colors border border-transparent hover:border-white/5">
                        <div className="w-8 h-8 rounded-lg bg-purple-500/20 text-purple-400 flex items-center justify-center shrink-0">
                          <CheckSquare className="w-4 h-4" />
                        </div>
                        <div className="flex-1 min-w-0">
                          <h4 className="text-sm font-bold text-white truncate">{task.title}</h4>
                          <p className="text-xs text-stone-400 capitalize">{task.status.replace('_', ' ')}</p>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {filteredClients.length > 0 && (
                <div>
                  <h3 className="text-xs font-bold text-stone-400 mb-2 px-2 uppercase tracking-wider">العملاء ({filteredClients.length})</h3>
                  <div className="space-y-1">
                    {filteredClients.slice(0, 5).map(client => (
                      <div key={client.id} className="flex items-center gap-3 p-3 rounded-xl hover:bg-white/5 cursor-pointer transition-colors border border-transparent hover:border-white/5">
                        <div className="w-8 h-8 rounded-lg bg-blue-500/20 text-blue-400 flex items-center justify-center shrink-0">
                          <Building2 className="w-4 h-4" />
                        </div>
                        <div className="flex-1 min-w-0">
                          <h4 className="text-sm font-bold text-white truncate">{client.name}</h4>
                          <p className="text-xs text-stone-400 capitalize">{client.status}</p>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {filteredUsers.length > 0 && (
                <div>
                  <h3 className="text-xs font-bold text-stone-400 mb-2 px-2 uppercase tracking-wider">الموظفين ({filteredUsers.length})</h3>
                  <div className="space-y-1">
                    {filteredUsers.slice(0, 5).map(user => (
                      <div key={user.id} className="flex items-center gap-3 p-3 rounded-xl hover:bg-white/5 cursor-pointer transition-colors border border-transparent hover:border-white/5">
                        <div className="w-8 h-8 rounded-lg bg-emerald-500/20 text-emerald-400 flex items-center justify-center shrink-0">
                          <User className="w-4 h-4" />
                        </div>
                        <div className="flex-1 min-w-0">
                          <h4 className="text-sm font-bold text-white truncate">{user.name}</h4>
                          <p className="text-xs text-stone-400 capitalize">{user.role.replace(/_/g, ' ')}</p>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {filteredTasks.length === 0 && filteredClients.length === 0 && filteredUsers.length === 0 && (
                <div className="p-8 text-center text-stone-500">
                  <p>لم يتم العثور على نتائج لـ "{query}"</p>
                </div>
              )}
            </div>
          )}
        </div>
        
        <div className="p-3 border-t border-white/10 bg-black/20 flex items-center justify-between text-[11px] text-stone-500">
          <div className="flex items-center gap-4">
            <span className="flex items-center gap-1.5"><kbd className="px-1.5 py-0.5 rounded bg-white/10 font-sans">↑</kbd><kbd className="px-1.5 py-0.5 rounded bg-white/10 font-sans">↓</kbd> للتنقل</span>
            <span className="flex items-center gap-1.5"><kbd className="px-1.5 py-0.5 rounded bg-white/10 font-sans">Enter</kbd> للاختيار</span>
          </div>
          <div className="flex items-center gap-1.5 font-sans">
            Kesra Search Engine
          </div>
        </div>
      </div>
    </div>
  );
};
