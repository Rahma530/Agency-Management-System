import React, { useState, useEffect, useRef } from 'react';
import { MessageSquare, X, Send, Search, Pencil, Trash2, Eraser, Check, CheckCheck, ArrowRight, CornerUpLeft, MoreVertical, Copy, Paperclip, Smile, Loader2, Image as ImageIcon, FileText, Download } from 'lucide-react';
import EmojiPicker, { Theme } from 'emoji-picker-react';
import { ChatConversationClearRecord, ChatDirectoryEntry, ChatMessageRecord, UserRecord } from '../types/database';

interface MiniChatProps {
  currentUser: UserRecord;
  // The org-wide chat directory (id/name/role only, from chat_directory()) — deliberately not
  // UserRecord: this list is unrestricted by design (any employee can message any employee),
  // unlike the employee_visible()-scoped `users` array used everywhere else in the app.
  users: ChatDirectoryEntry[];
  messages: ChatMessageRecord[];
  conversationClears: ChatConversationClearRecord[];
  // Resolves to whether the send actually succeeded, so the input text can be preserved
  // (not cleared) on failure — the caller persists first, so this only resolves once that's
  // known.
  onSendMessage: (receiverId: string, content: string, replyToId?: string, attachmentUrl?: string, attachmentName?: string, attachmentType?: string) => Promise<boolean>;
  onUploadChatAttachment?: (file: File) => Promise<{url: string, name: string, type: string} | null>;
  onEditMessage: (messageId: string, content: string) => Promise<boolean>;
  onDeleteMessage: (messageId: string) => Promise<boolean>;
  onClearConversation: (otherUserId: string) => Promise<boolean>;
  // Fired when a conversation is opened, so the caller can mark that thread's unread
  // messages read. Optional so existing callers/tests that don't need read-tracking
  // aren't forced to pass a no-op.
  onOpenConversation?: (otherUserId: string) => void;
  // Set by the caller (a fresh object each time, even for the same userId — see App.tsx) to
  // imperatively open this chat straight to a specific conversation, e.g. from a notification
  // click. Same shape as CrossTeamTaskBoard's initialAssigneeFilter prefill pattern.
  openConversationRequest?: { userId: string } | null;
  onlineUserIds?: string[];
}

export const MiniChat: React.FC<MiniChatProps> = ({
  currentUser,
  users,
  messages,
  conversationClears,
  onSendMessage,
  onUploadChatAttachment,
  onEditMessage,
  onDeleteMessage,
  onClearConversation,
  onOpenConversation,
  openConversationRequest,
  onlineUserIds = [],
}) => {
  const [isOpen, setIsOpen] = useState(false);
  const [selectedUserId, setSelectedUserId] = useState<string | null>(null);
  const [inputText, setInputText] = useState('');
  const [colleagueSearch, setColleagueSearch] = useState('');
  const [editingMessageId, setEditingMessageId] = useState<string | null>(null);
  const [editingText, setEditingText] = useState('');
  const [replyingToMessage, setReplyingToMessage] = useState<ChatMessageRecord | null>(null);
  const [hoveredMessageId, setHoveredMessageId] = useState<string | null>(null);
  const [activeDropdownId, setActiveDropdownId] = useState<string | null>(null);
  const [showEmojiPicker, setShowEmojiPicker] = useState(false);
  const [isUploadingAttachment, setIsUploadingAttachment] = useState(false);
  const [attachmentPreview, setAttachmentPreview] = useState<{url: string, name: string, type: string, file: File} | null>(null);
  
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

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
    if ((!inputText.trim() && !attachmentPreview) || !selectedUserId || isUploadingAttachment) return;
    
    let uploadedUrl: string | undefined = undefined;
    let uploadedName: string | undefined = undefined;
    let uploadedType: string | undefined = undefined;
    
    if (attachmentPreview && onUploadChatAttachment) {
      setIsUploadingAttachment(true);
      const uploadResult = await onUploadChatAttachment(attachmentPreview.file);
      if (uploadResult) {
        uploadedUrl = uploadResult.url;
        uploadedName = uploadResult.name;
        uploadedType = uploadResult.type;
      } else {
        setIsUploadingAttachment(false);
        return; // Upload failed, stop send
      }
    }

    // Capture current input and attachment to clear UI immediately for perceived performance
    const textToSend = inputText;
    const currentReplyToId = replyingToMessage?.id;
    
    setInputText('');
    setReplyingToMessage(null);
    setAttachmentPreview(null);
    setIsUploadingAttachment(false);
    setShowEmojiPicker(false);

    const success = await onSendMessage(
      selectedUserId, 
      textToSend, 
      currentReplyToId,
      uploadedUrl,
      uploadedName,
      uploadedType
    );
    
    if (!success) {
      // Restore on failure
      setInputText(textToSend);
      setReplyingToMessage(replyingToMessage);
    }
  };

  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      // Check size (max 10MB)
      if (file.size > 10 * 1024 * 1024) {
        alert('الملف كبير جداً. الحد الأقصى 10 ميجا.');
        return;
      }
      
      const type = file.type.startsWith('image/') ? 'image' : 'file';
      const url = URL.createObjectURL(file);
      setAttachmentPreview({ url, name: file.name, type, file });
    }
    // Clear input so same file can be selected again
    if (e.target) e.target.value = '';
  };

  const handleKeyPress = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  const handleSaveEdit = async () => {
    if (!editingMessageId || !editingText.trim()) return;
    const success = await onEditMessage(editingMessageId, editingText);
    if (success) {
      setEditingMessageId(null);
      setEditingText('');
    }
  };

  const handleDelete = async (messageId: string) => {
    if (!window.confirm('Delete this message?')) return;
    const success = await onDeleteMessage(messageId);
    if (success && editingMessageId === messageId) {
      setEditingMessageId(null);
      setEditingText('');
    }
  };

  const handleClearConversation = async () => {
    if (!selectedUserId || !window.confirm('Clear this conversation for you? Existing messages will remain available to the other participant.')) return;
    const success = await onClearConversation(selectedUserId);
    if (success) {
      setSelectedUserId(null);
      setEditingMessageId(null);
      setEditingText('');
    }
  };

  const isMessageVisible = (message: ChatMessageRecord) => {
    const otherUserId = message.sender_id === currentUser.id ? message.receiver_id : message.sender_id;
    const clearedAt = conversationClears.find(
      (clear) => clear.user_id === currentUser.id && clear.other_user_id === otherUserId
    )?.cleared_at;
    return !clearedAt || new Date(message.created_at).getTime() > new Date(clearedAt).getTime();
  };

  // Filter messages between current user and selected user
  const chatHistory = messages.filter(
    (m) =>
      ((m.sender_id === currentUser.id && m.receiver_id === selectedUserId) ||
        (m.sender_id === selectedUserId && m.receiver_id === currentUser.id)) &&
      isMessageVisible(m)
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
  const unreadCount = messages.filter(
    (m) => m.receiver_id === currentUser.id && !m.is_read && isMessageVisible(m)
  ).length;

  // Per-colleague unread count, so the sender is identifiable at a glance in the list instead
  // of having to open every thread to find out who messaged.
  const unreadCountByColleague = messages.reduce((acc, m) => {
    if (m.receiver_id === currentUser.id && !m.is_read && isMessageVisible(m)) {
      acc[m.sender_id] = (acc[m.sender_id] || 0) + 1;
    }
    return acc;
  }, {} as Record<string, number>);

  return (
    <div className="fixed bottom-4 right-4 sm:bottom-6 sm:right-6 z-[90] flex flex-col items-end" dir="rtl">
      {/* Chat Window */}
      {isOpen && (
        <div
          className="mb-4 w-[calc(100vw-2rem)] sm:w-[380px] h-[550px] max-h-[80vh] rounded-2xl shadow-2xl flex flex-col overflow-hidden border border-white/10 animate-in slide-in-from-bottom-5 fade-in duration-200"
          style={{ background: 'var(--gradient-card)' }}
        >
          {/* Header */}
          <div className="p-3 border-b border-white/10 flex items-center justify-between bg-black/20">
            {selectedUserId ? (
              <div className="flex items-center gap-2">
                <button 
                  onClick={() => setSelectedUserId(null)} 
                  className="bg-purple-600 hover:bg-purple-500 text-white transition-colors text-xs px-2.5 py-1.5 rounded-lg flex items-center gap-1.5 font-bold shadow-sm border border-purple-400/30"
                >
                  <ArrowRight className="w-3.5 h-3.5" />
                  عودة
                </button>
                <div className="flex items-center gap-2">
                  <div className="w-8 h-8 rounded-full bg-purple-500/20 text-purple-400 flex items-center justify-center text-sm font-bold relative shrink-0">
                    {selectedUser?.name.charAt(0)}
                    {(() => {
                      if (!selectedUser) return null;
                      const isOnline = onlineUserIds.includes(selectedUser.id);
                      const lastSeen = selectedUser.last_seen_at ? new Date(selectedUser.last_seen_at).getTime() : 0;
                      const isAway = !isOnline && (Date.now() - lastSeen < 15 * 60 * 1000);
                      const colorClass = isOnline ? 'bg-emerald-400' : isAway ? 'bg-orange-400' : 'bg-stone-500';
                      return (
                        <div className={`absolute bottom-0 right-0 w-2.5 h-2.5 rounded-full ${colorClass} border-2 border-[#1c1626]`} />
                      );
                    })()}
                  </div>
                  <div className="flex flex-col">
                    <span className="font-bold text-sm text-white">{selectedUser?.name}</span>
                    <span className="text-[10px] text-stone-400 flex items-center gap-1">
                      {(() => {
                        if (!selectedUser) return '';
                        if (onlineUserIds.includes(selectedUser.id)) return 'متصل الآن';
                        if (!selectedUser.last_seen_at) return 'غير متصل';
                        
                        const diffMins = Math.floor((Date.now() - new Date(selectedUser.last_seen_at).getTime()) / 60000);
                        if (diffMins < 1) return 'نشط منذ لحظات';
                        if (diffMins < 60) return `نشط منذ ${diffMins} دقيقة`;
                        
                        const diffHours = Math.floor(diffMins / 60);
                        if (diffHours < 24) return `نشط منذ ${diffHours} س`;
                        
                        const diffDays = Math.floor(diffHours / 24);
                        return `نشط منذ ${diffDays} ي`;
                      })()}
                    </span>
                  </div>
                </div>
              </div>
            ) : (
              <h3 className="font-bold text-white text-sm flex items-center gap-2">
                <MessageSquare className="w-4 h-4 text-purple-400" />
                المحادثة الداخلية
              </h3>
            )}
            <div className="flex items-center gap-1">
              {selectedUserId && (
                <button
                  onClick={handleClearConversation}
                  className="p-1.5 hover:bg-red-500/10 rounded-lg transition-colors text-stone-400 hover:text-red-300"
                  title="مسح المحادثة"
                >
                  <Eraser className="w-4 h-4" />
                </button>
              )}
              <button
                onClick={() => {
                  if (selectedUserId) {
                    setSelectedUserId(null);
                  } else {
                    setIsOpen(false);
                  }
                }}
                className="p-1.5 bg-red-500/10 hover:bg-red-500/20 rounded-lg transition-colors text-red-400 hover:text-red-300 border border-red-500/20"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
          </div>

          {/* Body */}
          <div className="flex-1 overflow-hidden flex flex-col bg-black/10">
            {!selectedUserId ? (
              // Users List
              <div className="flex-1 flex flex-col min-h-0">
                <div className="p-3 border-b border-white/5 shrink-0">
                  <div className="relative">
                    <Search className="w-3.5 h-3.5 absolute right-3 top-2.5 text-stone-500 pointer-events-none" />
                    <input
                      type="text"
                      value={colleagueSearch}
                      onChange={(e) => setColleagueSearch(e.target.value)}
                      placeholder="ابحث عن زميل..."
                      className="w-full bg-white/5 border border-white/10 rounded-xl pr-9 pl-3 py-2 text-xs text-white placeholder:text-stone-500 focus:outline-none focus:border-purple-500/50"
                    />
                  </div>
                </div>
                <div className="flex-1 overflow-y-auto custom-scrollbar p-2 space-y-1">
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
                        {(() => {
                          const isOnline = onlineUserIds.includes(user.id);
                          const lastSeen = user.last_seen_at ? new Date(user.last_seen_at).getTime() : 0;
                          const isAway = !isOnline && (Date.now() - lastSeen < 15 * 60 * 1000);
                          const colorClass = isOnline ? 'bg-emerald-400' : isAway ? 'bg-orange-400' : 'bg-stone-500';
                          return (
                            <div className={`absolute bottom-0 right-0 w-3 h-3 rounded-full ${colorClass} border-2 border-[#1c1626]`} />
                          );
                        })()}
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
                        <div 
                          key={msg.id} 
                          className={`flex items-center gap-2 relative group ${isMe ? 'justify-end' : 'justify-start'}`}
                          onMouseEnter={() => setHoveredMessageId(msg.id)}
                          onMouseLeave={() => { setHoveredMessageId(null); setActiveDropdownId(null); }}
                        >
                          {/* Three Dots Menu (Outside, Left side for sent messages) */}
                          {isMe && (
                            <div className={`relative transition-opacity opacity-100`}>
                              <button
                                onClick={() => setActiveDropdownId(activeDropdownId === msg.id ? null : msg.id)}
                                className={`p-1.5 rounded-full border border-white/10 transition-colors ${activeDropdownId === msg.id ? 'bg-white/10 text-white' : 'text-stone-400 hover:bg-white/5 hover:text-white'}`}
                              >
                                <MoreVertical className="w-4 h-4" />
                              </button>
                              
                              {activeDropdownId === msg.id && (
                                <div className={`absolute bottom-full mb-1 right-0 w-32 bg-[#1c1626] border border-white/10 rounded-xl shadow-xl overflow-hidden py-1 z-20`}>
                                  <button
                                    onClick={() => { navigator.clipboard.writeText(msg.content); setActiveDropdownId(null); }}
                                    className="w-full text-right px-3 py-2 text-xs text-stone-300 hover:bg-white/5 hover:text-white flex items-center justify-between"
                                  >
                                    <span>نسخ النص</span>
                                    <Copy className="w-3.5 h-3.5" />
                                  </button>
                                  {msg.attachment_url && (
                                    <button
                                      onClick={async () => {
                                        try {
                                          const response = await fetch(msg.attachment_url!);
                                          const blob = await response.blob();
                                          const url = URL.createObjectURL(blob);
                                          const a = document.createElement('a');
                                          a.href = url;
                                          a.download = msg.attachment_name || 'download';
                                          document.body.appendChild(a);
                                          a.click();
                                          document.body.removeChild(a);
                                          URL.revokeObjectURL(url);
                                        } catch { window.open(msg.attachment_url!, '_blank'); }
                                        setActiveDropdownId(null);
                                      }}
                                      className="w-full text-right px-3 py-2 text-xs text-stone-300 hover:bg-white/5 hover:text-white flex items-center justify-between"
                                    >
                                      <span>تحميل {msg.attachment_type === 'image' ? 'الصورة' : 'الملف'}</span>
                                      <Download className="w-3.5 h-3.5" />
                                    </button>
                                  )}
                                  <button
                                    onClick={() => { setEditingMessageId(msg.id); setEditingText(msg.content); setActiveDropdownId(null); }}
                                    className="w-full text-right px-3 py-2 text-xs text-stone-300 hover:bg-white/5 hover:text-white flex items-center justify-between"
                                  >
                                    <span>تعديل</span>
                                    <Pencil className="w-3.5 h-3.5" />
                                  </button>
                                  <button
                                    onClick={() => { handleDelete(msg.id); setActiveDropdownId(null); }}
                                    className="w-full text-right px-3 py-2 text-xs text-red-400 hover:bg-red-500/10 flex items-center justify-between border-t border-white/5 mt-1 pt-2"
                                  >
                                    <span>حذف</span>
                                    <Trash2 className="w-3.5 h-3.5" />
                                  </button>
                                </div>
                              )}
                            </div>
                          )}

                          {/* Message Bubble */}
                          <div 
                            className={`max-w-[80%] p-3 rounded-2xl text-sm ${
                              isMe 
                                ? 'bg-purple-600 text-white rounded-tr-sm' 
                                : 'bg-white/10 text-stone-200 rounded-tl-sm border border-white/5'
                            }`}
                          >
                            {editingMessageId === msg.id ? (
                              <div className="flex items-center gap-1">
                                <input
                                  autoFocus
                                  value={editingText}
                                  onChange={(event) => setEditingText(event.target.value)}
                                  onKeyDown={(event) => {
                                    if (event.key === 'Enter') {
                                      event.preventDefault();
                                      handleSaveEdit();
                                    }
                                  }}
                                  className="min-w-0 flex-1 bg-black/20 border border-white/20 rounded-lg px-2 py-1 text-sm text-white focus:outline-none focus:border-white/50"
                                />
                                <button onClick={handleSaveEdit} className="p-1 text-white hover:bg-white/10 rounded" title="حفظ">
                                  <Check className="w-3.5 h-3.5" />
                                </button>
                                <button onClick={() => { setEditingMessageId(null); setEditingText(''); }} className="p-1 text-white hover:bg-white/10 rounded" title="إلغاء">
                                  <X className="w-3.5 h-3.5" />
                                </button>
                              </div>
                            ) : (
                              <>
                                {/* Explicit Reply Button Inside Bubble */}
                                <div className={`flex ${isMe ? 'justify-end' : 'justify-start'} mb-2`}>
                                  <button
                                    onClick={() => setReplyingToMessage(msg)}
                                    className="flex items-center gap-1.5 px-2 py-1 rounded-md text-[10px] font-medium transition-colors border border-white/10 bg-black/20 hover:bg-black/40 text-stone-200"
                                    title="رد على الرسالة"
                                  >
                                    رد
                                    <CornerUpLeft className="w-3 h-3" />
                                  </button>
                                </div>

                                {msg.reply_to_id && (
                                  <div className="mb-2 p-2 rounded-lg bg-black/20 border-r-2 border-purple-400 text-xs opacity-75">
                                    <p className="font-bold mb-0.5">
                                      {messages.find(m => m.id === msg.reply_to_id)?.sender_id === currentUser.id ? 'أنت' : selectedUser?.name.split(' ')[0]}
                                    </p>
                                    <p className="truncate">
                                      {messages.find(m => m.id === msg.reply_to_id)?.content || 'رسالة محذوفة'}
                                    </p>
                                  </div>
                                )}
                                
                                {msg.attachment_url && (
                                  <div className="mb-2 w-full max-w-full">
                                    {msg.attachment_type === 'image' ? (
                                      <a href={msg.attachment_url} target="_blank" rel="noreferrer">
                                        <img src={msg.attachment_url} alt="Attachment" className="w-full h-auto max-h-64 rounded-xl object-cover cursor-pointer" />
                                      </a>
                                    ) : (
                                      <a href={msg.attachment_url} target="_blank" rel="noreferrer" className="flex items-center justify-between gap-3 p-3 bg-black/20 hover:bg-black/30 rounded-xl transition-colors border border-white/5">
                                        <div className="flex items-center gap-2 overflow-hidden">
                                          <FileText className="w-5 h-5 shrink-0 text-white/90" />
                                          <span className="truncate text-sm font-medium text-white/90" dir="ltr">{msg.attachment_name || 'ملف مرفق'}</span>
                                        </div>
                                        <div className="w-8 h-8 rounded-full bg-black/20 flex items-center justify-center shrink-0">
                                          <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" className="text-white/90"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" x2="12" y1="15" y2="3"/></svg>
                                        </div>
                                      </a>
                                    )}
                                  </div>
                                )}

                                {msg.content && <p>{msg.content}</p>}
                              </>
                            )}

                            {/* Footer: Timestamp and Checkmarks */}
                            <div className={`mt-1.5 flex items-center ${isMe ? 'justify-end' : 'justify-start'}`}>
                              <div className="flex items-center gap-1 text-[9px] opacity-75">
                                {new Date(msg.created_at).toLocaleTimeString('ar-EG', { hour: '2-digit', minute: '2-digit' })}
                                {isMe && (
                                  msg.is_read ? (
                                    <CheckCheck className="w-4 h-4 text-[#4ade80]" />
                                  ) : (
                                    <Check className="w-3.5 h-3.5 text-white" />
                                  )
                                )}
                              </div>
                            </div>
                          </div>

                          {/* Three Dots Menu (Outside, Right side for received messages) */}
                          {!isMe && (
                            <div className={`relative transition-opacity opacity-100`}>
                              <button
                                onClick={() => setActiveDropdownId(activeDropdownId === msg.id ? null : msg.id)}
                                className={`p-1.5 rounded-full border border-white/10 transition-colors ${activeDropdownId === msg.id ? 'bg-white/10 text-white' : 'text-stone-400 hover:bg-white/5 hover:text-white'}`}
                              >
                                <MoreVertical className="w-4 h-4" />
                              </button>
                              
                              {activeDropdownId === msg.id && (
                                <div className={`absolute bottom-full mb-1 left-0 w-32 bg-[#1c1626] border border-white/10 rounded-xl shadow-xl overflow-hidden py-1 z-20`}>
                                  <button
                                    onClick={() => { navigator.clipboard.writeText(msg.content); setActiveDropdownId(null); }}
                                    className="w-full text-right px-3 py-2 text-xs text-stone-300 hover:bg-white/5 hover:text-white flex items-center justify-between"
                                  >
                                    <span>نسخ النص</span>
                                    <Copy className="w-3.5 h-3.5" />
                                  </button>
                                  {msg.attachment_url && (
                                    <button
                                      onClick={async () => {
                                        try {
                                          const response = await fetch(msg.attachment_url!);
                                          const blob = await response.blob();
                                          const url = URL.createObjectURL(blob);
                                          const a = document.createElement('a');
                                          a.href = url;
                                          a.download = msg.attachment_name || 'download';
                                          document.body.appendChild(a);
                                          a.click();
                                          document.body.removeChild(a);
                                          URL.revokeObjectURL(url);
                                        } catch { window.open(msg.attachment_url!, '_blank'); }
                                        setActiveDropdownId(null);
                                      }}
                                      className="w-full text-right px-3 py-2 text-xs text-stone-300 hover:bg-white/5 hover:text-white flex items-center justify-between"
                                    >
                                      <span>تحميل {msg.attachment_type === 'image' ? 'الصورة' : 'الملف'}</span>
                                      <Download className="w-3.5 h-3.5" />
                                    </button>
                                  )}
                                </div>
                              )}
                            </div>
                          )}
                        </div>
                      );
                    })
                  )}
                  <div ref={messagesEndRef} />
                </div>
                
                {/* Input Area */}
                <div className="relative border-t border-white/10 bg-black/20 flex flex-col">
                  {replyingToMessage && (
                    <div className="p-2 border-b border-white/5 bg-black/40 flex items-start justify-between">
                      <div className="flex-1 pr-2 border-r-2 border-purple-500">
                        <p className="text-xs font-bold text-purple-400 mb-0.5">
                          {replyingToMessage.sender_id === currentUser.id ? 'أنت' : selectedUser?.name.split(' ')[0]}
                        </p>
                        <p className="text-xs text-stone-300 truncate">
                          {replyingToMessage.content}
                        </p>
                      </div>
                      <button 
                        onClick={() => setReplyingToMessage(null)}
                        className="p-1 text-stone-500 hover:text-white rounded-lg transition-colors"
                      >
                        <X className="w-4 h-4" />
                      </button>
                    </div>
                  )}
                  {attachmentPreview && (
                    <div className="p-2 border-b border-white/5 bg-black/40 flex items-start justify-between">
                      <div className="flex items-center gap-2">
                        {attachmentPreview.type === 'image' ? (
                          <img src={attachmentPreview.url} alt="Preview" className="w-10 h-10 object-cover rounded-md" />
                        ) : (
                          <div className="w-10 h-10 bg-purple-500/20 rounded-md flex items-center justify-center">
                            <FileText className="w-5 h-5 text-purple-400" />
                          </div>
                        )}
                        <span className="text-xs text-stone-300 truncate max-w-[200px]" dir="ltr">
                          {attachmentPreview.name}
                        </span>
                      </div>
                      <button 
                        onClick={() => {
                          if (attachmentPreview.url.startsWith('blob:')) URL.revokeObjectURL(attachmentPreview.url);
                          setAttachmentPreview(null);
                        }}
                        className="p-1 text-stone-500 hover:text-white rounded-lg transition-colors"
                      >
                        <X className="w-4 h-4" />
                      </button>
                    </div>
                  )}
                  
                  {showEmojiPicker && (
                    <div className="absolute bottom-full left-2 mb-2 z-50">
                      <EmojiPicker 
                        theme={Theme.DARK} 
                        onEmojiClick={(emojiData) => setInputText(prev => prev + emojiData.emoji)}
                        searchDisabled
                        skinTonesDisabled
                        width={300}
                        height={350}
                      />
                    </div>
                  )}

                  <div className="p-3 bg-[#111623] relative">
                    <input type="file" ref={fileInputRef} className="hidden" onChange={handleFileSelect} />
                    <div className="flex items-center gap-3">
                      
                      {/* Input Wrapper */}
                      <div className="flex-1 flex items-center bg-[#1a1f2e] border border-[#2d3748] rounded-full px-4 h-11 relative overflow-hidden">
                        
                        {/* Right side actions inside input (Visually right in RTL) */}
                        <div className="flex items-center gap-1 ml-2">
                          <button
                            onClick={() => fileInputRef.current?.click()}
                            className="w-8 h-8 flex items-center justify-center rounded-full text-stone-400 hover:text-white hover:bg-white/10 transition-colors"
                          >
                            <Paperclip className="w-5 h-5" />
                          </button>

                          <button
                            onClick={() => setShowEmojiPicker(!showEmojiPicker)}
                            className="w-8 h-8 flex items-center justify-center rounded-full text-stone-400 hover:text-white hover:bg-white/10 transition-colors"
                          >
                            <Smile className="w-5 h-5" />
                          </button>
                        </div>
                        
                        <input
                          type="text"
                          value={inputText}
                          onChange={(e) => setInputText(e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter') {
                              e.preventDefault();
                              handleSend();
                            }
                          }}
                          placeholder="اكتب رسالتك هنا... و @ للمنشن"
                          className="flex-1 bg-transparent text-sm text-white placeholder-stone-500 focus:outline-none py-2 border-none ring-0"
                          dir="rtl"
                        />
                      </div>

                      {/* Send Button (Far Left visually in RTL context) */}
                      <button
                        onClick={handleSend}
                        disabled={(!inputText.trim() && !attachmentPreview) || isUploadingAttachment}
                        className="w-10 h-10 flex shrink-0 items-center justify-center bg-purple-600 text-white rounded-full transition-colors hover:bg-purple-500 disabled:opacity-50 disabled:hover:bg-purple-600 shadow-sm cursor-pointer"
                      >
                        {isUploadingAttachment ? (
                          <Loader2 className="w-5 h-5 animate-spin" />
                        ) : (
                          <Send className="w-5 h-5 -ml-1" />
                        )}
                      </button>

                    </div>
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
        className="relative w-12 h-12 sm:w-14 sm:h-14 rounded-full shadow-lg shadow-purple-500/50 flex items-center justify-center transition-transform hover:scale-105 active:scale-95 bg-purple-600 hover:bg-purple-500 border border-purple-400/30"
      >
        {isOpen ? <X className="w-5 h-5 sm:w-6 sm:h-6 text-white" /> : <MessageSquare className="w-5 h-5 sm:w-6 sm:h-6 text-white" />}
        {unreadCount > 0 && (
          <div className="absolute -top-1 -right-1 w-5 h-5 rounded-full bg-red-500 text-white text-[10px] font-bold flex items-center justify-center border-2 border-[#1c1626]">
            {unreadCount > 9 ? '9+' : unreadCount}
          </div>
        )}
      </button>
    </div>
  );
};
