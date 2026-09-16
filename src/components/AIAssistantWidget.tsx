import React, { useState } from 'react';
import { Bot, MessageSquare, Sparkles } from 'lucide-react';

export const AIAssistantWidget: React.FC = () => {
  const [isOpen, setIsOpen] = useState(false);

  const openAIWindow = (url: string) => {
    const width = 800;
    const height = 700;
    const left = window.screen.width / 2 - width / 2;
    const top = window.screen.height / 2 - height / 2;
    
    window.open(
      url,
      'AIAssistant',
      `width=${width},height=${height},top=${top},left=${left},toolbar=no,menubar=no,scrollbars=yes,resizable=yes`
    );
    setIsOpen(false);
  };

  return (
    <div className="fixed bottom-6 left-6 z-[90] flex flex-col-reverse items-center gap-3" dir="rtl"
         onMouseEnter={() => setIsOpen(true)}
         onMouseLeave={() => setIsOpen(false)}>
      
      <button
        className="w-14 h-14 rounded-2xl bg-indigo-600 text-white shadow-lg shadow-indigo-600/30 flex items-center justify-center transition-all duration-200 group"
        title="المساعد الذكي (AI Assistant)"
      >
        <Bot className="w-7 h-7 group-hover:scale-110 transition-transform" />
      </button>

      <div className={`flex flex-col gap-2 transition-all duration-300 ${isOpen ? 'opacity-100 translate-y-0' : 'opacity-0 translate-y-4 pointer-events-none'}`}>
        <button
          onClick={() => openAIWindow('https://chatgpt.com')}
          className="w-12 h-12 rounded-xl bg-[#10a37f] text-white shadow-lg flex items-center justify-center hover:scale-110 transition-transform"
          title="افتح ChatGPT"
        >
          <Sparkles className="w-5 h-5" />
        </button>
        <button
          onClick={() => openAIWindow('https://claude.ai')}
          className="w-12 h-12 rounded-xl bg-[#d97757] text-white shadow-lg flex items-center justify-center hover:scale-110 transition-transform"
          title="افتح Claude"
        >
          <MessageSquare className="w-5 h-5" />
        </button>
      </div>
    </div>
  );
};
