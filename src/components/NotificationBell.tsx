import React, { useState, useRef, useEffect } from 'react';
import { Bell, Check, Info, FileText, AlertTriangle } from 'lucide-react';
import { NotificationRecord, UserRecord } from '../types/database';
import { getRoleInfo } from '../data/roles';

interface NotificationBellProps {
  notifications: NotificationRecord[];
  users: UserRecord[];
  onMarkAsRead: (id: string) => void;
  onMarkAllAsRead: () => void;
  // Fired alongside onMarkAsRead when a notification is clicked, so the caller can act on its
  // link_url (e.g. open a chat conversation). Optional — a notification with no actionable
  // link_url is still fine to just mark read.
  onNotificationClick?: (notification: NotificationRecord) => void;
}

export const NotificationBell: React.FC<NotificationBellProps> = ({
  notifications,
  users,
  onMarkAsRead,
  onMarkAllAsRead,
  onNotificationClick,
}) => {
  const [isOpen, setIsOpen] = useState(false);
  const [isRinging, setIsRinging] = useState(false);
  const prevUnreadCount = useRef(0);
  const dropdownRef = useRef<HTMLDivElement>(null);

  // Added 2026-11-08: a notification arriving while this browser tab is open but NOT the active/
  // focused tab was silent, even though everything else about the notification (badge count, bell
  // animation) worked fine. Root cause: the old code created a brand-new AudioContext on every
  // single notification. Browsers' autoplay policy only lets an AudioContext start producing sound
  // without an explicit, recent user gesture in the ACTIVE tab — a freshly-created context in a
  // background tab is typically created already 'suspended' and stays silent. An AudioContext that
  // is already 'running', though, keeps producing sound even after its tab loses focus — so the fix
  // is to create ONE context lazily, unlock/resume it the first time the user interacts with the
  // page at all (while the tab is necessarily focused, since that's how a click/keydown reaches it)
  // and reuse that same running context for every later notification, including ones that arrive
  // while a different tab is focused.
  const audioCtxRef = useRef<AudioContext | null>(null);
  const getAudioContext = (): AudioContext | null => {
    const AudioCtx = window.AudioContext || (window as any).webkitAudioContext;
    if (!AudioCtx) return null;
    if (!audioCtxRef.current) {
      audioCtxRef.current = new AudioCtx();
    }
    return audioCtxRef.current;
  };

  useEffect(() => {
    // Any real interaction with the page — necessarily happening while this tab is focused —
    // creates/unlocks the shared AudioContext once, so it's already 'running' by the time a later
    // notification needs to play a sound from a background tab.
    const unlockAudio = () => {
      const ctx = getAudioContext();
      if (ctx && ctx.state === 'suspended') {
        ctx.resume().catch(() => {});
      }
    };
    window.addEventListener('pointerdown', unlockAudio, { once: true });
    window.addEventListener('keydown', unlockAudio, { once: true });
    return () => {
      window.removeEventListener('pointerdown', unlockAudio);
      window.removeEventListener('keydown', unlockAudio);
    };
  }, []);

  const unreadCount = notifications.filter((n) => !n.is_read).length;
  const visibleNotifications = notifications.filter((n) => !n.is_read);

  // تأثير الصوت والحركة عند وصول إشعار جديد
  useEffect(() => {
    if (unreadCount > prevUnreadCount.current) {
      // Trigger Animation
      setIsRinging(true);
      setTimeout(() => setIsRinging(false), 2000);

      // Play Sound (Synthetic Pop/Tick)
      try {
        const ctx = getAudioContext();
        if (ctx) {
          const playTone = () => {
            const osc = ctx.createOscillator();
            const gainNode = ctx.createGain();

            osc.type = 'sine';
            osc.frequency.setValueAtTime(800, ctx.currentTime);
            osc.frequency.exponentialRampToValueAtTime(1200, ctx.currentTime + 0.1);

            gainNode.gain.setValueAtTime(0.5, ctx.currentTime);
            gainNode.gain.exponentialRampToValueAtTime(0.01, ctx.currentTime + 0.1);

            osc.connect(gainNode);
            gainNode.connect(ctx.destination);

            osc.start();
            osc.stop(ctx.currentTime + 0.1);
          };
          if (ctx.state === 'suspended') {
            // Background-tab notification arriving before any interaction ever unlocked the
            // context (e.g. the very first notification of the session) — still attempt resume();
            // browsers that allow it will play the tone, the rest silently stay suspended same as
            // today, which is a no-worse-than-before fallback, not a regression.
            ctx.resume().then(playTone).catch(() => {});
          } else {
            playTone();
          }
        }
      } catch (e) {
        console.log("Audio playback prevented or unsupported");
      }
    }
    prevUnreadCount.current = unreadCount;
  }, [unreadCount]);

  // إغلاق القائمة عند النقر خارجها
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(event.target as Node)) {
        setIsOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  const getSenderInfo = (senderId?: string | null) => {
    const user = users.find((u) => u.id === senderId);
    if (!user) return { name: 'نظام الإدارة', role: '' };
    const roleInfo = getRoleInfo(user.role);
    return { name: user.name, role: roleInfo.arabicTitle };
  };

  return (
    <div className="relative" ref={dropdownRef}>
      {/* Bell Button */}
      <button
        onClick={() => setIsOpen(!isOpen)}
        className={`relative p-2 rounded-xl border backdrop-blur-md shadow-sm cursor-pointer transition-colors group ${isRinging ? 'animate-bounce bg-amber-500/20' : 'hover:bg-white/10'}`}
        style={{
          background: isRinging ? undefined : 'rgba(28, 22, 38, 0.85)',
          borderColor: isRinging ? 'rgba(245, 158, 11, 0.5)' : 'var(--border-soft)',
        }}
        title="الإشعارات"
      >
        <Bell className={`w-5 h-5 transition-colors ${isRinging ? 'text-amber-400 animate-pulse' : 'text-amber-500 group-hover:text-amber-400'}`} />
        
        {unreadCount > 0 && (
          <div className="absolute -top-1 -right-1 w-4 h-4 rounded-full bg-red-500 text-white text-[9px] font-bold flex items-center justify-center border-2 border-[#1c1626]">
            {unreadCount > 9 ? '9+' : unreadCount}
          </div>
        )}
      </button>

      {/* Dropdown Menu */}
      {isOpen && (
        <div
          className="absolute top-full right-0 mt-2 w-[calc(100vw-2rem)] max-w-80 rounded-2xl border shadow-2xl overflow-hidden z-50 animate-in fade-in slide-in-from-top-2 duration-200"
          style={{ background: 'var(--gradient-card)', borderColor: 'var(--border-soft)' }}
          dir="rtl"
        >
          <div className="p-4 border-b border-white/5 flex items-center justify-between bg-black/20">
            <h3 className="font-bold text-white text-sm">الإشعارات ({unreadCount})</h3>
            {visibleNotifications.length > 0 && (
              <button 
                onClick={onMarkAllAsRead}
                className="text-[10px] text-purple-400 hover:text-purple-300 font-medium transition-colors"
              >
                مسح الإشعارات
              </button>
            )}
          </div>

          <div className="max-h-[60vh] overflow-y-auto custom-scrollbar">
            {visibleNotifications.length === 0 ? (
              <div className="p-8 text-center text-stone-500 text-sm">
                <Bell className="w-8 h-8 mx-auto mb-2 opacity-20" />
                لا توجد إشعارات حالياً
              </div>
            ) : (
              <div className="flex flex-col">
                {visibleNotifications.map((notification) => {
                  const sender = getSenderInfo(notification.sender_id);
                  return (
                    <div
                      key={notification.id}
                      onClick={() => {
                        onMarkAsRead(notification.id);
                        onNotificationClick?.(notification);
                      }}
                      className={`p-4 border-b border-white/5 cursor-pointer transition-colors flex gap-3
                        ${notification.is_read ? 'hover:bg-white/5 opacity-70' : 'bg-purple-900/10 hover:bg-purple-900/20'}`}
                    >
                      <div className="shrink-0 mt-1">
                        {notification.type === 'task_assigned' && (
                          <div className="w-8 h-8 rounded-full bg-purple-500/20 text-purple-400 flex items-center justify-center">
                            <FileText className="w-4 h-4" />
                          </div>
                        )}
                        {notification.type === 'task_overdue' && (
                          <div className="w-8 h-8 rounded-full bg-red-500/20 text-red-400 flex items-center justify-center">
                            <AlertTriangle className="w-4 h-4" />
                          </div>
                        )}
                        {(notification.type === 'task_updated' || notification.type === 'general') && (
                          <div className="w-8 h-8 rounded-full bg-blue-500/20 text-blue-400 flex items-center justify-center">
                            <Info className="w-4 h-4" />
                          </div>
                        )}
                      </div>
                      
                      <div className="flex-1 min-w-0">
                        <div className="flex items-start justify-between gap-2 mb-1">
                          <h4 className={`text-sm font-bold truncate ${notification.is_read ? 'text-stone-300' : 'text-white'}`}>
                            {notification.title}
                          </h4>
                          {!notification.is_read && (
                            <span className="w-2 h-2 rounded-full bg-purple-500 shrink-0 mt-1.5" />
                          )}
                        </div>
                        <p className="text-xs text-stone-400 line-clamp-2 mb-2 leading-relaxed">
                          {notification.message}
                        </p>
                        <div className="text-[10px] flex items-center gap-1.5 text-stone-500">
                          <span className="text-stone-300 font-medium">{sender.name}</span>
                          <span>•</span>
                          <span>{sender.role}</span>
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
};
