import React, { useState } from 'react';
import { UploadCloud, X, UserPlus, Building2, AlertTriangle, FileText, CheckCircle2 } from 'lucide-react';

interface ImportDataModalProps {
  isOpen: boolean;
  onClose: () => void;
  type: 'users' | 'clients';
  onImport: (data: any[], method: 'manual' | 'csv') => void;
}

export const ImportDataModal: React.FC<ImportDataModalProps> = ({
  isOpen,
  onClose,
  type,
  onImport,
}) => {
  const [activeTab, setActiveTab] = useState<'csv' | 'manual'>('csv');
  const [csvData, setCsvData] = useState('');
  const [manualName, setManualName] = useState('');
  const [manualEmail, setManualEmail] = useState('');
  const [manualRole, setManualRole] = useState(''); // Used for both role (users) and package (clients)

  if (!isOpen) return null;

  const isUsers = type === 'users';
  const title = isUsers ? 'إضافة موظفين' : 'إضافة عملاء';
  const icon = isUsers ? <UserPlus className="w-5 h-5 text-emerald-400" /> : <Building2 className="w-5 h-5 text-blue-400" />;

  const handleManualSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!manualName.trim()) return;
    
    const record = isUsers 
      ? { name: manualName, email: manualEmail, role: manualRole || 'designer' }
      : { name: manualName, email: manualEmail, packageId: manualRole || 'basic_social' };
      
    onImport([record], 'manual');
    onClose();
  };

  const handleCsvSubmit = () => {
    if (!csvData.trim()) return;
    
    // Basic CSV parsing
    const lines = csvData.trim().split('\n');
    const records = lines.map(line => {
      const parts = line.split(',');
      if (isUsers) {
        return {
          name: parts[0]?.trim() || 'موظف جديد',
          email: parts[1]?.trim() || '',
          role: parts[2]?.trim() || 'designer'
        };
      } else {
        return {
          name: parts[0]?.trim() || 'عميل جديد',
          email: parts[1]?.trim() || '',
          packageId: parts[2]?.trim() || 'basic_social'
        };
      }
    });

    onImport(records, 'csv');
    onClose();
  };

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={onClose} />
      
      <div 
        className="relative w-full max-w-2xl rounded-2xl shadow-2xl overflow-hidden border border-white/10 animate-in fade-in zoom-in-95"
        style={{ background: 'var(--gradient-card)' }}
        dir="rtl"
      >
        <div className="p-4 border-b border-white/10 flex items-center justify-between bg-black/20">
          <h2 className="text-lg font-bold text-white flex items-center gap-2">
            {icon}
            {title}
          </h2>
          <button onClick={onClose} className="p-2 hover:bg-white/10 rounded-lg text-stone-400 hover:text-white transition-colors">
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Tabs */}
        <div className="flex border-b border-white/10">
          <button
            onClick={() => setActiveTab('csv')}
            className={`flex-1 p-3 text-sm font-bold flex items-center justify-center gap-2 transition-colors ${
              activeTab === 'csv' 
                ? 'bg-purple-600/20 text-purple-400 border-b-2 border-purple-500' 
                : 'text-stone-400 hover:bg-white/5 hover:text-stone-300'
            }`}
          >
            <UploadCloud className="w-4 h-4" />
            استيراد ملف CSV
          </button>
          <button
            onClick={() => setActiveTab('manual')}
            className={`flex-1 p-3 text-sm font-bold flex items-center justify-center gap-2 transition-colors ${
              activeTab === 'manual' 
                ? 'bg-purple-600/20 text-purple-400 border-b-2 border-purple-500' 
                : 'text-stone-400 hover:bg-white/5 hover:text-stone-300'
            }`}
          >
            <FileText className="w-4 h-4" />
            إدخال يدوي
          </button>
        </div>

        <div className="p-6">
          {activeTab === 'csv' ? (
            <div className="space-y-4">
              <div className="p-4 rounded-xl border border-dashed border-white/20 bg-black/20 text-center space-y-3">
                <UploadCloud className="w-10 h-10 text-stone-500 mx-auto" />
                <div>
                  <p className="text-stone-300 font-bold text-sm">قم بلصق محتوى ملف CSV هنا</p>
                  <p className="text-stone-500 text-xs mt-1">
                    {isUsers 
                      ? 'الترتيب: الاسم، الإيميل، الدور (مثال: أحمد, ahmed@test.com, designer)' 
                      : 'الترتيب: اسم الشركة، الإيميل، الباقة (مثال: شركة الأمل, info@alamal.com, premium)'}
                  </p>
                </div>
                <textarea
                  value={csvData}
                  onChange={(e) => setCsvData(e.target.value)}
                  className="w-full h-32 bg-white/5 border border-white/10 rounded-lg p-3 text-sm text-white placeholder:text-stone-600 focus:outline-none focus:border-purple-500/50 mt-4"
                  placeholder="أحمد, ahmed@test.com, designer&#10;محمد, mohamed@test.com, copywriter"
                  dir="ltr"
                />
              </div>
              
              <div className="flex justify-end pt-2">
                <button
                  onClick={handleCsvSubmit}
                  disabled={!csvData.trim()}
                  className="px-6 py-2 rounded-xl text-sm font-bold text-white transition-all disabled:opacity-50 disabled:cursor-not-allowed hover:-translate-y-0.5"
                  style={{ background: 'var(--gradient-badge)' }}
                >
                  استيراد البيانات
                </button>
              </div>
            </div>
          ) : (
            <form onSubmit={handleManualSubmit} className="space-y-4">
              <div>
                <label className="block text-xs font-bold text-stone-400 mb-1.5">
                  {isUsers ? 'اسم الموظف' : 'اسم العميل / الشركة'}
                </label>
                <input
                  type="text"
                  required
                  value={manualName}
                  onChange={(e) => setManualName(e.target.value)}
                  className="w-full bg-black/40 border border-white/10 rounded-xl px-4 py-2.5 text-sm text-white focus:outline-none focus:border-purple-500/50"
                  placeholder={isUsers ? 'مثال: كريم المنصور' : 'مثال: شركة الأفق'}
                />
              </div>
              
              <div>
                <label className="block text-xs font-bold text-stone-400 mb-1.5">
                  البريد الإلكتروني (اختياري)
                </label>
                <input
                  type="email"
                  value={manualEmail}
                  onChange={(e) => setManualEmail(e.target.value)}
                  className="w-full bg-black/40 border border-white/10 rounded-xl px-4 py-2.5 text-sm text-white focus:outline-none focus:border-purple-500/50"
                  placeholder="email@example.com"
                  dir="ltr"
                />
              </div>

              <div>
                <label className="block text-xs font-bold text-stone-400 mb-1.5">
                  {isUsers ? 'الدور (Role)' : 'الباقة (Package)'}
                </label>
                {isUsers ? (
                  <select
                    value={manualRole}
                    onChange={(e) => setManualRole(e.target.value)}
                    className="w-full bg-black/40 border border-white/10 rounded-xl px-4 py-2.5 text-sm text-white focus:outline-none focus:border-purple-500/50"
                  >
                    <option value="designer">مصمم (Designer)</option>
                    <option value="copywriter">كاتب محتوى (Copywriter)</option>
                    <option value="media_buyer">ميديا باير (Media Buyer)</option>
                    <option value="am_team_lead">مدير حسابات (Account Manager)</option>
                  </select>
                ) : (
                  <select
                    value={manualRole}
                    onChange={(e) => setManualRole(e.target.value)}
                    className="w-full bg-black/40 border border-white/10 rounded-xl px-4 py-2.5 text-sm text-white focus:outline-none focus:border-purple-500/50"
                  >
                    <option value="basic_social">السوشال ميديا الأساسية</option>
                    <option value="premium_social">السوشال ميديا الشاملة</option>
                    <option value="seo_growth">باقة الـ SEO الأساسية</option>
                    <option value="media_buying_perf">أداء الإعلانات (Media Buying)</option>
                  </select>
                )}
              </div>

              <div className="flex justify-end pt-4">
                <button
                  type="submit"
                  disabled={!manualName.trim()}
                  className="px-6 py-2 rounded-xl text-sm font-bold text-white transition-all disabled:opacity-50 disabled:cursor-not-allowed hover:-translate-y-0.5"
                  style={{ background: 'var(--gradient-badge)' }}
                >
                  حفظ البيانات
                </button>
              </div>
            </form>
          )}
        </div>
      </div>
    </div>
  );
};
