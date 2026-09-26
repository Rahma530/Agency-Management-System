import React from 'react';
import { UserRecord, TaskRecord, ClientRecord } from '../types/database';
import { X, Mail, Shield, CheckCircle2, Clock, PlayCircle, Users } from 'lucide-react';
import { getRoleInfo } from '../data/roles';
import { isTaskDone } from '../lib/taskLifecycle';
import { createPortal } from 'react-dom';

interface EmployeeProfileModalProps {
  user: UserRecord;
  tasks: TaskRecord[];
  clients: ClientRecord[];
  onClose: () => void;
}

export const EmployeeProfileModal: React.FC<EmployeeProfileModalProps> = ({
  user,
  tasks,
  clients,
  onClose,
}) => {
  const roleInfo = getRoleInfo(user.role);

  // Filter Data
  const assignedTasks = tasks.filter((t) => t.assigned_to === user.id);
  const todoTasks = assignedTasks.filter((t) => t.status === 'todo');
  const inProgressTasks = assignedTasks.filter((t) => t.status === 'in_progress');
  const reviewTasks = assignedTasks.filter((t) => t.status === 'review');
  const completedTasks = assignedTasks.filter((t) => isTaskDone(t.status));

  const assignedClients = clients.filter(
    (c) => c.am_agent_id === user.id || c.sales_owner_id === user.id
  );

  const modalContent = (
    <div className="fixed inset-0 z-[120] flex items-center justify-center p-4 bg-black/70 backdrop-blur-md animate-in fade-in duration-200">
      <div
        className="w-full max-w-2xl rounded-[22px] border shadow-2xl overflow-hidden flex flex-col relative"
        style={{
          background: 'var(--gradient-card)',
          borderColor: 'var(--border-strong)',
          maxHeight: '90vh',
        }}
        dir="rtl"
      >
        {/* Header with Avatar and Basic Info */}
        <div className="relative p-8 border-b border-white/5 bg-gradient-to-br from-purple-900/20 to-black/40">
          <button
            onClick={onClose}
            className="absolute top-4 left-4 p-2 rounded-xl hover:bg-white/10 transition-colors text-stone-400 hover:text-white"
          >
            <X className="w-5 h-5" />
          </button>

          <div className="flex items-center gap-6">
            {/* Large Avatar */}
            <div
              className="w-24 h-24 rounded-2xl flex items-center justify-center text-4xl font-black relative border-2 border-[#1c1626] shadow-xl"
              style={{ background: 'var(--gradient-badge)', color: 'var(--white)' }}
            >
              {user.name.charAt(0)}
              <div className="absolute -bottom-1 -right-1 w-5 h-5 rounded-full bg-emerald-400 border-4 border-[#1c1626] shadow-[0_0_12px_rgba(52,211,153,0.8)]" title="أونلاين" />
            </div>

            <div className="flex-1 min-w-0">
              <h2 className="text-2xl font-bold text-white mb-2">{user.name}</h2>
              <div className="flex flex-wrap gap-4 text-stone-400">
                <div className="flex items-center gap-2 text-sm" dir="ltr">
                  <Shield className="w-4 h-4 text-purple-400" />
                  <span className="font-medium text-stone-200 capitalize">{user.role.replace(/_/g, ' ')}</span>
                </div>
                <div className="flex items-center gap-2 text-sm" dir="ltr">
                  <Mail className="w-4 h-4 text-blue-400" />
                  <span>{user.email}</span>
                </div>
              </div>
            </div>
          </div>
        </div>

        {/* Scrollable Body */}
        <div className="flex-1 overflow-y-auto p-6 space-y-6 custom-scrollbar">
          {/* Quick Metrics */}
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            <div className="p-4 rounded-xl bg-black/30 border border-white/5">
              <div className="text-stone-400 text-xs mb-1 flex items-center gap-1.5">
                <Clock className="w-3.5 h-3.5" /> مهام معلقة
              </div>
              <div className="text-2xl font-bold text-stone-200">{todoTasks.length}</div>
            </div>
            <div className="p-4 rounded-xl bg-purple-900/10 border border-purple-500/20">
              <div className="text-purple-300 text-xs mb-1 flex items-center gap-1.5">
                <PlayCircle className="w-3.5 h-3.5" /> قيد العمل
              </div>
              <div className="text-2xl font-bold text-purple-400">{inProgressTasks.length}</div>
            </div>
            <div className="p-4 rounded-xl bg-emerald-900/10 border border-emerald-500/20">
              <div className="text-emerald-300 text-xs mb-1 flex items-center gap-1.5">
                <CheckCircle2 className="w-3.5 h-3.5" /> مكتملة
              </div>
              <div className="text-2xl font-bold text-emerald-400">{completedTasks.length}</div>
            </div>
            <div className="p-4 rounded-xl bg-blue-900/10 border border-blue-500/20">
              <div className="text-blue-300 text-xs mb-1 flex items-center gap-1.5">
                <Users className="w-3.5 h-3.5" /> العملاء
              </div>
              <div className="text-2xl font-bold text-blue-400">{assignedClients.length}</div>
            </div>
          </div>

          {/* Detailed Tasks List */}
          <div>
            <h3 className="text-lg font-bold text-white mb-4 border-b border-white/10 pb-2">
              المهام المفتوحة الحالية ({todoTasks.length + inProgressTasks.length + reviewTasks.length})
            </h3>
            
            {assignedTasks.filter(t => !isTaskDone(t.status)).length === 0 ? (
              <div className="text-center p-8 text-stone-500 border border-dashed border-stone-700/50 rounded-xl">
                لا توجد مهام مفتوحة حالياً لهذا الموظف.
              </div>
            ) : (
              <div className="space-y-3">
                {assignedTasks
                  .filter((t) => !isTaskDone(t.status))
                  .sort((a, b) => (a.status === 'in_progress' ? -1 : 1)) // Bring In-Progress to top
                  .map((task) => (
                    <div
                      key={task.id}
                      className="p-4 rounded-xl border flex flex-col sm:flex-row sm:items-center justify-between gap-4 transition-colors"
                      style={{
                        background: 'rgba(28, 22, 38, 0.5)',
                        borderColor: 'var(--border-soft)',
                      }}
                    >
                      <div className="flex-1">
                        <div className="font-bold text-stone-200 mb-1">{task.title}</div>
                        <div className="text-xs text-stone-500 line-clamp-1">{task.description}</div>
                      </div>
                      
                      {/* Status Badge */}
                      <div className="shrink-0 flex items-center gap-2">
                        {task.status === 'in_progress' && (
                          <span className="px-3 py-1 text-xs font-bold bg-purple-900/30 text-purple-400 rounded-full border border-purple-500/20 flex items-center gap-1.5">
                            <span className="w-1.5 h-1.5 rounded-full bg-purple-400 animate-pulse" />
                            جاري العمل
                          </span>
                        )}
                        {task.status === 'todo' && (
                          <span className="px-3 py-1 text-xs font-bold bg-stone-800 text-stone-400 rounded-full border border-stone-700/50">
                            في الانتظار
                          </span>
                        )}
                        {task.status === 'review' && (
                          <span className="px-3 py-1 text-xs font-bold bg-yellow-900/30 text-yellow-400 rounded-full border border-yellow-500/20">
                            قيد المراجعة
                          </span>
                        )}
                      </div>
                    </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );

  return createPortal(modalContent, document.body);
};
