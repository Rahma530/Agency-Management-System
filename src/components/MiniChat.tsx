import React, { useState, useEffect, useRef } from 'react';
import { MessageSquare, X, Send, User, Search } from 'lucide-react';
import { ChatDirectoryEntry, ChatMessageRecord, UserRecord } from '../types/database';

interface MiniChatProps {
  currentUser: UserRecord;
  // The org-wide chat directory (id/name/role only, from chat_directory()) — deliberately not
  // UserRecord: this list is unrestricted by design (any employee can message any employee),
  // unlike the employee_visible()-scoped `users` array used everywhere else in the app.
  users: ChatDirectoryEntry[];
  messages: ChatMessageRecord[];
  // Resolves to whether the send actually succeeded, so the input text can be preserved
  // (not cleared) on failure — the caller persists first, so this only resolves once that's
  // known.
  onSendMessage: (receiverId: string, content: string) => Promise<boolean>;
  // Fired when a conversation is opened, so the caller can mark that thread's unread
  // messages read. Optional so existing callers/tests that don't need read-tracking
  // aren't forced to pass a no-op.
  onOpenConversation?: (otherUserId: string) => void;
  // Set by the caller (a fresh object each time, even for the same userId — see App.tsx) to
  // imperatively open this chat straight to a specific conversation, e.g. from a notification
  // click. Same shape as CrossTeamTaskBoard's initialAssigneeFilter prefill pattern.
  openConversationRequest?: { userId: string } | null;
}

export const MiniChat: React.FC<MiniChatProps> = ({
  currentUser,
  users,
  messages,
  onSendMessage,
  onOpenConversation,
  openConversationRequest,
}) => {
  const [isOpen, setIsOpen] = useState(false);
  const [selectedUserId, setSelectedUserId] = useState<string | null>(null);
  const [inputText, setInputText] = useState('');
  const [colleagueSearch, setColleagueSearch] = useState('');
  const messagesEndRef = useRef<HTMLDivElement>(null);

  // Auto scroll to bottom when new messages arrive
  useEffect(() => {
    if (messagesEndRef.current) {
      messagesEndRef.current.scrollIntoView({ behavior: 'smooth' });
    }
  }, [messages, isOpen, selectedUserId]);

  // Opens straight to a specific conversation on request (e.g. a notification click) — a new
  // object reference every time from the caller, so this refires even for a second click on a
  // notification from the same sender.
  useEffect(() => {
    if (openConversationRequest?.userId) {
      setIsOpen(true);
      setSelectedUserId(openConversationRequest.userId);
      onOpenConversation?.(openConversationRequest.userId);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [openConversationRequest]);

  // onOpenConversation only fires once, at the moment a conversation is first selected — it
  // never re-fires for a message that arrives WHILE that conversation is already open, so the
  // FAB badge kept counting those as unread even while the user was actively looking at the
  // thread. Re-invoking it (idempotent — a no-op once there's nothing left unread) whenever the
  // open conversation's messages change closes that gap.
  useEffect(() => {
    if (isOpen && selectedUserId) {
      onOpenConversation?.(selectedUserId);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [messages, isOpen, selectedUserId]);

  const handleSend = async () => {
    if (!inputText.trim() || !selectedUserId) return;
    const success = await onSendMessage(selectedUserId, inputText.trim());
    // Only clear on confirmed success — a failed send leaves the typed text in place so it
    // isn't lost, rather than silently discarding it with only a notification as feedback.
    if (success) {
      setInputText('');
    }
  };

  const handleKeyPress = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  // Filter messages between current user and selected user
  const chatHistory = messages.filter(
    (m) =>
      (m.sender_id === currentUser.id && m.receiver_id === selectedUserId) ||
      (m.sender_id === selectedUserId && m.receiver_id === currentUser.id)
  ).sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime());

  // Colleagues (everyone except current user), optionally narrowed by the search box below —
  // case-insensitive substring match on name, same predicate shape as matchesClientQuery
  // (lib/clientSearch.ts), kept local since this is currently the only employee-name search
  // in the codebase.
  const colleagues = users
    .filter(u => u.id !== currentUser.id)
    .filter(u => u.name.toLowerCase().includes(colleagueSearch.trim().toLowerCase()));
  const selectedUser = users.find(u => u.id === selectedUserId);

  // Unread count for the FAB badge — messages is already scoped to conversations involving
  // currentUser (sender or receiver), so this only needs the receiver/is_read check.
  const unreadCount = messages.filter((m) => m.receiver_id === currentUser.id && !m.is_read).length;

  // Per-colleague unread count, so the sender is identifiable at a glance in the list instead
  // of having to open every thread to find out who messaged.
  const unreadCountByColleague = messages.reduce((acc, m) => {
    if (m.receiver_id === currentUser.id && !m.is_read) {
      acc[m.sender_id] = (acc[m.sender_id] || 0) + 1;
    }
    return acc;
  }, {} as Record<string, number>);

  return (
    <div className="fixed bottom-6 right-6 z-[90] flex flex-col items-end" dir="rtl">
      {/* Chat Window */}
      {isOpen && (
        <div 
          className="mb-4 w-80 h-96 rounded-2xl shadow-2xl flex flex-col overflow-hidden border border-white/10 animate-in slide-in-from-bottom-5 fade-in duration-200"
          style={{ background: 'var(--gradient-card)' }}
        >
          {/* Header */}
          <div className="p-3 border-b border-white/10 flex items-center justify-between bg-black/20">
            {selectedUserId ? (
              <div className="flex items-center gap-2">
                <button onClick={() => setSelectedUserId(null)} className="text-stone-400 hover:text-white transition-colors text-xs">
                  ← عودة
                </button>
                <div className="font-bold text-sm text-white flex items-center gap-2">
                  <div className="w-6 h-6 rounded-full bg-purple-500/20 text-purple-400 flex items-center justify-center text-[10px]">
                    {selectedUser?.name.charAt(0)}
                  </div>
                  {selectedUser?.name}
                </div>
              </div>
            ) : (
              <h3 className="font-bold text-white text-sm flex items-center gap-2">
                <MessageSquare className="w-4 h-4 text-purple-400" />
                المحادثة الداخلية
              </h3>
            )}
            <button
              onClick={() => setIsOpen(false)}
              className="p-1.5 hover:bg-white/10 rounded-lg transition-colors text-stone-400 hover:text-white"
            >
              <X className="w-4 h-4" />
            </button>
          </div>

          {/* Body */}
          <div className="flex-1 overflow-hidden flex flex-col bg-black/10">
            {!selectedUserId ? (
              // Users List
              <div className="flex-1 overflow-y-auto custom-scrollbar p-2 space-y-1">
                <div className="relative px-1 pb-1 sticky top-0 bg-inherit z-10">
                  <Search className="w-3.5 h-3.5 absolute right-4 top-2.5 text-stone-500 pointer-events-none" />
                  <input
                    type="text"
                    value={colleagueSearch}
                    onChange={(e) => setColleagueSearch(e.target.value)}
                    placeholder="ابحث عن زميل..."
                    className="w-full bg-white/5 border border-white/10 rounded-xl pr-9 pl-3 py-2 text-xs text-white placeholder:text-stone-500 focus:outline-none focus:border-purple-500/50"
                  />
                </div>
                {colleagues.length === 0 && (
                  <p className="text-center text-xs text-stone-500 py-4">لا يوجد نتائج</p>
                )}
                {colleagues.map(user => {
                  const unreadFromUser = unreadCountByColleague[user.id] || 0;
                  return (
                    <button
                      key={user.id}
                      onClick={() => {
                        setSelectedUserId(user.id);
                        onOpenConversation?.(user.id);
                      }}
                      className="w-full flex items-center gap-3 p-3 rounded-xl hover:bg-white/5 transition-colors text-right"
                    >
                      <div className="w-10 h-10 rounded-full bg-white/5 border border-white/10 flex items-center justify-center text-lg font-bold text-white relative shrink-0">
                        {user.name.charAt(0)}
                        {/* Fake online status for demo */}
                        <div className="absolute bottom-0 right-0 w-3 h-3 rounded-full bg-emerald-400 border-2 border-[#1c1626]" />
                      </div>
                      <div className="flex-1 min-w-0">
                        <h4 className="text-sm font-bold text-white truncate">{user.name}</h4>
                        <p className="text-xs text-stone-400 truncate">{user.role.replace(/_/g, ' ')}</p>
                      </div>
                      {unreadFromUser > 0 && (
                        <div className="w-5 h-5 rounded-full bg-red-500 text-white text-[10px] font-bold flex items-center justify-center shrink-0">
                          {unreadFromUser > 9 ? '9+' : unreadFromUser}
                        </div>
                      )}
                    </button>
                  );
                })}
              </div>
            ) : (
              // Chat Interface
              <>
                <div className="flex-1 overflow-y-auto custom-scrollbar p-4 space-y-4">
                  {chatHistory.length === 0 ? (
                    <div className="h-full flex flex-col items-center justify-center text-stone-500 text-sm">
                      <MessageSquare className="w-8 h-8 mb-2 opacity-20" />
                      <p>ابدأ المحادثة مع {selectedUser?.name.split(' ')[0]}</p>
                    </div>
                  ) : (
                    chatHistory.map((msg) => {
                      const isMe = msg.sender_id === currentUser.id;
                      return (
                        <div key={msg.id} className={`flex ${isMe ? 'justify-start' : 'justify-end'}`}>
                          <div 
                            className={`max-w-[80%] p-3 rounded-2xl text-sm ${
                              isMe 
                                ? 'bg-purple-600 text-white rounded-tr-sm' 
                                : 'bg-white/10 text-stone-200 rounded-tl-sm border border-white/5'
                            }`}
                          >
                            {msg.content}
                            <div className={`text-[9px] mt-1 opacity-60 ${isMe ? 'text-right' : 'text-left'}`}>
                              {new Date(msg.created_at).toLocaleTimeString('ar-EG', { hour: '2-digit', minute: '2-digit' })}
                            </div>
                          </div>
                        </div>
                      );
                    })
                  )}
                  <div ref={messagesEndRef} />
                </div>
                
                {/* Input Area */}
                <div className="p-3 border-t border-white/10 bg-black/20">
                  <div className="relative">
                    <input
                      type="text"
                      value={inputText}
                      onChange={(e) => setInputText(e.target.value)}
                      onKeyDown={handleKeyPress}
                      placeholder="اكتب رسالتك..."
                      className="w-full bg-white/5 border border-white/10 rounded-xl pr-4 pl-10 py-2 text-sm text-white placeholder:text-stone-500 focus:outline-none focus:border-purple-500/50"
                    />
                    <button
                      onClick={handleSend}
                      disabled={!inputText.trim()}
                      className="absolute left-1.5 top-1.5 p-1.5 rounded-lg bg-purple-600 text-white hover:bg-purple-500 disabled:opacity-50 disabled:hover:bg-purple-600 transition-colors"
                    >
                      <Send className="w-3.5 h-3.5" />
                    </button>
                  </div>
                </div>
              </>
            )}
          </div>
        </div>
      )}

      {/* Floating Action Button */}
      <button
        onClick={() => setIsOpen(!isOpen)}
        className="relative w-14 h-14 rounded-full shadow-lg shadow-purple-500/50 flex items-center justify-center transition-transform hover:scale-105 active:scale-95 bg-purple-600 hover:bg-purple-500 border border-purple-400/30"
      >
        {isOpen ? <X className="w-6 h-6 text-white" /> : <MessageSquare className="w-6 h-6 text-white" />}
        {unreadCount > 0 && (
          <div className="absolute -top-1 -right-1 w-5 h-5 rounded-full bg-red-500 text-white text-[10px] font-bold flex items-center justify-center border-2 border-[#1c1626]">
            {unreadCount > 9 ? '9+' : unreadCount}
          </div>
        )}
      </button>
    </div>
  );
};
