import React, { useState } from 'react';
import { createPortal } from 'react-dom';
import { UserRecord, TaskRecord, ClientRecord } from '../types/database';
import { X, Mail, Shield } from 'lucide-react';
import { EmployeeProfileModal } from './EmployeeProfileModal';

interface OnlineUsersWidgetProps {
  users: UserRecord[];
  tasks: TaskRecord[];
  clients: ClientRecord[];
  onlineUserIds: string[];
}

export const OnlineUsersWidget: React.FC<OnlineUsersWidgetProps> = ({ users, tasks, clients, onlineUserIds }) => {
  const [isSidebarOpen, setIsSidebarOpen] = useState(false);
  const [selectedEmployee, setSelectedEmployee] = useState<UserRecord | null>(null);
  const onlineUsers = users.filter((u) => onlineUserIds.includes(u.id));

  // عرض أول 4 مستخدمين فقط، والباقي نكتب رقمه (مثل +2)
  const displayUsers = onlineUsers.slice(0, 4);
  const remainingCount = onlineUsers.length - displayUsers.length;

  if (onlineUsers.length === 0) return null;

  const sidebarContent = isSidebarOpen ? (
    <>
      {/* Overlay */}
      <div 
        className="fixed inset-0 z-[100] bg-black/50 backdrop-blur-sm animate-in fade-in duration-300"
        onClick={() => setIsSidebarOpen(false)}
      />
      
      {/* Sidebar Panel - Sliding from left in RTL layout */}
      <div 
        className="fixed top-0 bottom-0 left-0 z-[110] w-full max-w-sm flex flex-col border-r shadow-2xl animate-in slide-in-from-left duration-300"
        style={{ 
          background: 'var(--gradient-page)', 
          borderColor: 'var(--border-strong)',
        }}
        dir="rtl"
      >
        {/* Sidebar Header */}
        <div className="flex items-center justify-between p-6 border-b shrink-0" style={{ borderColor: 'var(--border-soft)', background: 'rgba(10, 10, 13, 0.4)' }}>
          <h2 className="text-xl font-bold flex items-center gap-3 text-white">
            <div className="w-3 h-3 rounded-full bg-emerald-400 animate-pulse shadow-[0_0_12px_rgba(52,211,153,0.8)]" />
            المتواجدون الآن ({onlineUsers.length})
          </h2>
          <button 
            onClick={() => setIsSidebarOpen(false)}
            className="p-2 rounded-xl hover:bg-white/10 transition-colors text-stone-400 hover:text-white border border-transparent hover:border-white/10 shrink-0"
          >
            <X className="w-5 h-5" />
          </button>
        </div>
        
        {/* Users List */}
        <div className="flex-1 overflow-y-auto p-4 flex flex-col gap-3 custom-scrollbar">
          {onlineUsers.map(user => (
            <div 
              key={user.id} 
              onClick={() => setSelectedEmployee(user)}
              className="flex gap-4 p-4 rounded-xl border border-white/5 transition-all hover:bg-white/5 hover:border-purple-500/30 group cursor-pointer" 
              style={{ background: 'rgba(28, 22, 38, 0.4)' }}
            >
              
              {/* Avatar */}
              <div
                className="w-12 h-12 rounded-xl flex items-center justify-center text-lg font-bold relative border border-[#1c1626] shrink-0 group-hover:scale-105 transition-transform"
                style={{ background: 'var(--gradient-badge)', color: 'var(--white)' }}
              >
                {user.name.charAt(0)}
                <div className="absolute -bottom-1 -right-1 w-3.5 h-3.5 rounded-full bg-emerald-400 border-2 border-[#1c1626]" />
              </div>
              
              {/* Details */}
              <div className="flex-1 flex flex-col justify-center min-w-0">
                <div className="font-bold text-sm text-white truncate mb-1 text-right">{user.name}</div>
                
                <div className="flex flex-col gap-1.5 w-full text-stone-400" dir="rtl">
                  {/* Role */}
                  <div className="flex items-center justify-end gap-2 text-[11px]" dir="ltr">
                    <Shield className="w-3 h-3 text-purple-400 opacity-70" />
                    <span className="capitalize font-medium text-stone-300 truncate">{user.role.replace(/_/g, ' ')}</span>
                  </div>
                  
                  {/* Email */}
                  <div className="flex items-center justify-end gap-2 text-[11px]" dir="ltr">
                    <Mail className="w-3 h-3 text-blue-400 opacity-70" />
                    <span className="truncate text-stone-400">{user.email}</span>
                  </div>
                </div>
              </div>
            </div>
          ))}
        </div>
      </div>
    </>
  ) : null;

  return (
    <>
      {/* Widget Button */}
      <div
        onClick={() => setIsSidebarOpen(true)}
        className="flex items-center gap-3 px-3 py-1.5 rounded-xl border backdrop-blur-md shadow-sm cursor-pointer hover:bg-white/5 transition-colors"
        style={{
          background: 'rgba(28, 22, 38, 0.85)',
          borderColor: 'var(--border-soft)',
        }}
        title="انقر لرؤية المستخدمين المتواجدين"
      >
        <div className="text-[10px] text-emerald-400 font-bold flex items-center gap-1.5 shrink-0">
          <div className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse shadow-[0_0_8px_rgba(52,211,153,0.8)]" />
          <span className="hidden sm:inline">أونلاين</span>
        </div>
        
        <div className="flex items-center -space-x-2 rtl:space-x-reverse">
          {displayUsers.map((user, idx) => (
            <div
              key={user.id}
              className="w-7 h-7 rounded-full flex items-center justify-center text-xs font-bold relative border-2 border-[#1c1626]"
              style={{
                background: 'var(--gradient-badge)',
                color: 'var(--white)',
                zIndex: 10 - idx,
              }}
            >
              {user.name.charAt(0)}
              <div className="absolute -bottom-0.5 -right-0.5 w-2.5 h-2.5 rounded-full bg-emerald-400 border-2 border-[#1c1626]" />
            </div>
          ))}
          {remainingCount > 0 && (
            <div
              className="w-7 h-7 rounded-full flex items-center justify-center text-[10px] font-bold bg-stone-800 text-stone-300 border-2 border-[#1c1626] relative"
              style={{ zIndex: 0 }}
            >
              +{remainingCount}
            </div>
          )}
        </div>
      </div>

      {/* Render the Sidebar outside the parent header to prevent cutoff */}
      {isSidebarOpen && createPortal(sidebarContent, document.body)}

      {/* Render Employee Profile Modal */}
      {selectedEmployee && (
        <EmployeeProfileModal
          user={selectedEmployee}
          tasks={tasks}
          clients={clients}
          onClose={() => setSelectedEmployee(null)}
        />
      )}
    </>
  );
};
