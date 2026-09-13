import React from 'react';
import { ActivityRecord, UserRecord } from '../types/database';
import { Clock, CheckCircle2, AlertCircle, PlayCircle, PlusCircle, Trash2 } from 'lucide-react';
import { getRoleInfo } from '../data/roles';

interface LiveActivityFeedProps {
  activities: ActivityRecord[];
  users: UserRecord[];
}

export const LiveActivityFeed: React.FC<LiveActivityFeedProps> = ({ activities, users }) => {
  const getActionIcon = (type: ActivityRecord['action_type']) => {
    switch (type) {
      case 'create': return <PlusCircle className="w-4 h-4 text-blue-400" />;
      case 'complete': return <CheckCircle2 className="w-4 h-4 text-emerald-400" />;
      case 'status_change': return <PlayCircle className="w-4 h-4 text-purple-400" />;
      case 'delete': return <Trash2 className="w-4 h-4 text-red-400" />;
      case 'update': return <AlertCircle className="w-4 h-4 text-amber-400" />;
      default: return <Clock className="w-4 h-4 text-stone-400" />;
    }
  };

  const formatTimeAgo = (dateString: string) => {
    const diff = Math.floor((Date.now() - new Date(dateString).getTime()) / 60000); // in minutes
    if (diff < 1) return 'الآن';
    if (diff < 60) return `منذ ${diff} دقيقة`;
    const hours = Math.floor(diff / 60);
    if (hours < 24) return `منذ ${hours} ساعة`;
    return `منذ ${Math.floor(hours / 24)} يوم`;
  };

  return (
    <div className="flex flex-col h-full rounded-2xl border border-white/5 overflow-hidden bg-black/20" dir="rtl">
      <div className="p-4 border-b border-white/5 bg-white/5 flex items-center justify-between">
        <h3 className="font-bold text-white flex items-center gap-2">
          <Clock className="w-4 h-4 text-purple-400" />
          Live Activity Feed ⚡
        </h3>
        <span className="flex h-2 w-2 relative">
          <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75"></span>
          <span className="relative inline-flex rounded-full h-2 w-2 bg-emerald-500"></span>
        </span>
      </div>
      
      <div className="flex-1 overflow-y-auto custom-scrollbar p-2 space-y-1">
        {activities.length === 0 ? (
          <div className="p-8 text-center text-stone-500 text-sm">
            لا توجد نشاطات حالياً
          </div>
        ) : (
          activities.map(activity => {
            const user = users.find(u => u.id === activity.user_id);
            const userName = user ? user.name : 'مستخدم';
            
            return (
              <div key={activity.id} className="flex gap-3 p-3 rounded-xl hover:bg-white/5 transition-colors">
                <div className="shrink-0 mt-0.5">
                  <div className="w-8 h-8 rounded-full bg-white/5 border border-white/10 flex items-center justify-center">
                    {getActionIcon(activity.action_type)}
                  </div>
                </div>
                <div className="flex-1 min-w-0">
                  <p className="text-sm text-stone-300">
                    <span className="font-bold text-white">{userName}</span>
                    {' قام بتحديث '}
                    <span className="text-purple-400">{activity.target_type === 'task' ? 'مهمة' : activity.target_type === 'client' ? 'عميل' : activity.target_type === 'campaign' ? 'حملة' : 'ملف'}</span>
                    {': '}
                    <span className="text-stone-300 font-medium">{activity.target_name}</span>
                  </p>
                  {activity.details && (
                    <p className="text-xs text-stone-500 mt-0.5">{activity.details}</p>
                  )}
                  <div className="text-[10px] text-stone-500 mt-1.5 flex items-center gap-1">
                    <Clock className="w-3 h-3" />
                    {formatTimeAgo(activity.created_at)}
                  </div>
                </div>
              </div>
            );
          })
        )}
      </div>
    </div>
  );
};
