import React, { useState } from 'react';
import { ArrowRight, ShieldAlert, ShieldCheck } from 'lucide-react';

// Neutral landing page for admin-generated employee invitation/recovery links (see
// supabase/functions/employee-invitation/index.ts). Fixes a real production bug: a link pasted
// into a chat app (Telegram, Slack, WhatsApp, etc.) gets server-side prefetched the instant it's
// sent, to build a preview card — and https://<project>.supabase.co/auth/v1/verify performs its
// one-time-token consumption on a plain GET, so that crawl alone silently burns the token before
// the real recipient ever taps it. That's why the link only ever worked from the exact
// browser/device that generated it: that browser was the only one that ever made a genuine request
// against it before a crawler could.
//
// This page is what gets shared instead — it renders nothing but a static "Continue" button with
// no redirect or fetch on page load, so a crawler scraping it for a preview card never reaches the
// real verify URL. The real action_link is embedded in this page's own URL QUERY STRING
// (?verify=...), deliberately NOT a hash fragment (an earlier version of this fix used
// #/invite?verify=... and broke in live testing): a fragment is never sent in any HTTP request,
// including a crawler's — which sounds safer, but backfires once the crawler's resulting preview
// CARD gets tapped. index.html declares no <meta property="og:url">, so per the Open Graph default
// ("if og:url isn't specified, the URL of the page is assumed to be the canonical URL"), the
// crawler infers the tap target as literally the URL it fetched — and since the fragment was never
// part of that fetch, it silently vanishes, landing the real recipient on the bare app root with no
// signal this was ever an invite link at all (confirmed: Telegram's crawler is a plain, JS-free
// meta-tag scraper — "no browser, no JavaScript execution" — so it never even reaches this
// component to begin with; the failure was purely the fragment never surviving the round trip). A
// query string IS part of the actual HTTP request the crawler makes, so it survives being echoed
// back as the inferred canonical/tap-target URL — while remaining just as inert to the crawl itself,
// since this is static hosting with zero server-side logic: the crawler's GET returns the exact same
// index.html every time regardless of query string, and the real verify URL is never serialized into
// any `<a href>`/static markup a non-JS-executing scraper could read — it only ever exists in React
// state, reached solely via this button's onClick.
//
// This page does NOT handle what happens after that click: generateLink()'s redirectTo (see
// employee-invitation/index.ts's validated invitationRedirectUrl) still points at the plain app
// root, unchanged — so a successful verification lands back on App.tsx's existing, already-correct
// PASSWORD_RECOVERY handling (SetPasswordScreen), exactly as it does for the separate self-service
// "Forgot Password" flow (EmployeeLogin.tsx). A failed verification (link already used or expired)
// also lands at the app root, where App.tsx now surfaces Supabase's error/error_description params
// directly instead of silently falling through to the Sign In screen.
function getVerifyUrl(): string | null {
  const params = new URLSearchParams(window.location.search); // "?verify=<encoded action_link>"
  const value = params.get('verify');
  if (!value) return null;
  // Validated before ever being handed to window.location.href below — this value only ever comes
  // from this app's own trusted employee-invitation Edge Function in practice, but the "Continue"
  // click is a genuine navigation, so a maliciously crafted ?verify=javascript:... link must not
  // be able to use it as an XSS vector against whoever clicks the button.
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
  } catch {
    return null;
  }
  return value;
}

const InvitePageShell: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <div
    className="min-h-screen flex flex-col justify-center items-center py-12 px-4 sm:px-6 lg:px-8 font-sans text-[#e9d9fb] relative"
    dir="ltr"
    style={{ background: 'var(--gradient-page)' }}
  >
    <div className="fixed inset-0 pointer-events-none overflow-hidden">
      <div
        className="absolute -top-32 right-1/3 w-96 h-96 rounded-full blur-[150px] opacity-25"
        style={{ background: 'var(--purple-dark)' }}
      />
      <div
        className="absolute -bottom-32 left-1/3 w-96 h-96 rounded-full blur-[150px] opacity-20"
        style={{ background: '#3b82f6' }}
      />
    </div>
    <div
      className="relative w-full max-w-md rounded-2xl p-6 sm:p-8 shadow-2xl backdrop-blur-xl border text-center"
      style={{ background: 'rgba(21, 16, 32, 0.88)', borderColor: 'var(--border-strong)' }}
    >
      {children}
    </div>
  </div>
);

export const InvitePage: React.FC = () => {
  // Read once on mount — this page never re-derives it from a later URL change, and critically
  // never acts on it until the button below is actually clicked.
  const [verifyUrl] = useState(getVerifyUrl);

  if (!verifyUrl) {
    return (
      <InvitePageShell>
        <ShieldAlert className="w-10 h-10 text-amber-400 mb-4 mx-auto" />
        <h1 className="text-xl sm:text-2xl font-black tracking-tight text-white mb-2">Invalid invitation link</h1>
        <p className="text-xs sm:text-sm text-[#a89bb8]">
          This link is missing or incomplete. Ask an admin to resend your invitation.
        </p>
      </InvitePageShell>
    );
  }

  return (
    <InvitePageShell>
      <div
        className="inline-flex items-center justify-center w-16 h-16 rounded-2xl mb-4 shadow-2xl border"
        style={{ background: 'var(--gradient-badge)', borderColor: 'var(--border-strong)' }}
      >
        <ShieldCheck className="w-8 h-8 text-white" />
      </div>
      <h1 className="text-2xl sm:text-3xl font-black tracking-tight text-white mb-2">You're invited</h1>
      <p className="text-xs sm:text-sm text-[#a89bb8] mb-6">
        Click below to continue and set up your account password.
      </p>
      <button
        onClick={() => {
          window.location.href = verifyUrl;
        }}
        className="w-full flex items-center justify-center gap-2 px-5 py-3 rounded-xl text-sm font-bold text-white shadow-lg transition-all hover:opacity-90"
        style={{ background: 'var(--gradient-badge)', border: '1px solid var(--border-strong)' }}
      >
        Continue <ArrowRight className="w-4 h-4" />
      </button>
    </InvitePageShell>
  );
};
