import React, { useState } from 'react';
import { X, Mail, KeyRound } from 'lucide-react';

interface CreateClientPortalLoginModalProps {
  clientName: string;
  onClose: () => void;
  onSubmit: (email: string) => Promise<void>;
}

// Staff-side half of the invite-then-claim flow: creates the placeholder client_portal_users row
// (auth_id null). The client finishes setup themselves via ClientPortalLogin.tsx's "First Time?"
// path — this app has no service-role key to create their Supabase Auth account directly.
export const CreateClientPortalLoginModal: React.FC<CreateClientPortalLoginModalProps> = ({ clientName, onClose, onSubmit }) => {
  const [email, setEmail] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const isValidEmail = (val: string) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(val);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = email.trim().toLowerCase();
    if (!isValidEmail(trimmed)) {
      setErrorMessage('Please enter a valid email address.');
      return;
    }
    setErrorMessage(null);
    setIsSubmitting(true);
    try {
      await onSubmit(trimmed);
      onClose();
    } catch (err: any) {
      setErrorMessage(err?.message || 'Unable to create portal access. Please try again.');
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center p-4 bg-black/75 backdrop-blur-sm animate-fadeIn">
      <div
        className="w-full max-w-md rounded-2xl p-6 shadow-2xl border"
        style={{ background: 'rgba(21, 16, 32, 0.96)', borderColor: 'var(--border-strong)' }}
      >
        <div className="flex items-center justify-between pb-3 border-b border-purple-900/40 mb-4">
          <div>
            <h3 className="text-sm font-bold text-white flex items-center gap-2">
              <KeyRound className="w-4 h-4 text-purple-400" />
              Create Portal Login
            </h3>
            <p className="text-[11px] text-stone-400 mt-0.5">For {clientName}</p>
          </div>
          <button onClick={onClose} className="p-1 rounded-lg text-stone-400 hover:text-white hover:bg-purple-900/30 transition-colors">
            <X className="w-4 h-4" />
          </button>
        </div>

        {errorMessage && (
          <div
            className="mb-4 p-3 rounded-xl text-xs"
            style={{ background: 'rgba(245, 163, 163, 0.12)', color: 'var(--roas-bad)', border: '1px solid var(--roas-bad)' }}
          >
            {errorMessage}
          </div>
        )}

        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label className="block text-xs font-semibold text-stone-300 mb-1.5">Client's Portal Email</label>
            <div className="relative">
              <input
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="contact@clientcompany.com"
                dir="ltr"
                disabled={isSubmitting}
                className="w-full bg-[#110d1c] border border-purple-900/50 rounded-xl px-4 py-2.5 pl-10 text-sm text-white placeholder-stone-500 focus:outline-none focus:border-purple-400 font-mono disabled:opacity-50"
                required
              />
              <Mail className="absolute left-3.5 top-3 w-4 h-4 text-purple-400/70 pointer-events-none" />
            </div>
            <p className="text-[10px] text-stone-500 mt-1.5">
              The client will use this email to set up their own password from the portal login screen.
            </p>
          </div>

          <div className="flex items-center justify-end gap-2 pt-1">
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-2 rounded-xl text-xs text-stone-400 hover:text-white"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={isSubmitting}
              className="px-5 py-2 rounded-xl text-xs font-bold text-white shadow-lg transition-all disabled:opacity-50"
              style={{ background: 'var(--gradient-badge)' }}
            >
              {isSubmitting ? 'Creating...' : 'Create Portal Login'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};
