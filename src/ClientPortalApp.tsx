import React, { useCallback, useEffect, useState } from 'react';
import { supabase, supabaseRaw } from './lib/supabase';
import { ClientRecord, ClientPortalUserRecord } from './types/database';
import { ClientPortalLogin } from './components/clientPortal/ClientPortalLogin';
import { ClientPortalView } from './components/clientPortal/ClientPortalView';

// Top-level tree for #/client-portal/* URLs, mounted by main.tsx instead of (never alongside)
// <App/>. Deliberately a separate root, not a branch inside App.tsx: App's own session-
// restoration effect looks up public.users unconditionally for any authenticated session, which
// would silently fail for a client-portal session (no matching row) and leave it stuck on
// nothing. Keeping this as its own tree means that code path never runs for a client at all.
export default function ClientPortalApp() {
  const [portalUser, setPortalUser] = useState<ClientPortalUserRecord | null>(null);
  const [client, setClient] = useState<ClientRecord | null>(null);
  const [loading, setLoading] = useState(true);

  // Bypasses the employee-oriented `clients` RLS-emulation proxy (see supabaseRaw's own comment
  // in lib/supabase.ts) — this session never calls setSupabaseSessionUser, so that proxy has
  // nothing to key off; real access control is Postgres RLS (clients_select_portal_rls) either way.
  const loadPortalSession = useCallback(async () => {
    try {
      const {
        data: { session },
      } = await supabase.auth.getSession();
      if (!session?.user) {
        setPortalUser(null);
        setClient(null);
        return;
      }

      const { data: pu } = await supabase
        .from('client_portal_users')
        .select('*')
        .eq('auth_id', session.user.id)
        .maybeSingle();

      if (!pu) {
        setPortalUser(null);
        setClient(null);
        return;
      }

      setPortalUser(pu as ClientPortalUserRecord);

      const { data: c } = await supabaseRaw.from('clients').select('*').eq('id', pu.client_id).single();
      setClient((c as ClientRecord) || null);
    } catch (err) {
      console.warn('Client portal session check warning:', err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadPortalSession();

    const { data: authListener } = supabase.auth.onAuthStateChange((event) => {
      if (event === 'SIGNED_OUT') {
        setPortalUser(null);
        setClient(null);
      } else if (event === 'SIGNED_IN') {
        loadPortalSession();
      }
    });
    return () => authListener?.subscription?.unsubscribe();
  }, [loadPortalSession]);

  // Cosmetic/bookmarking only — the slug in the URL never gates access. Every data read is
  // scoped by portal_client_id() (resolved from the session, not the URL), so even a client who
  // edits the URL to another client's slug would only ever see their own data.
  useEffect(() => {
    if (client) {
      window.location.hash = `#/client-portal/${client.portal_slug || client.id}`;
    }
  }, [client]);

  const handleSignOut = async () => {
    await supabase.auth.signOut();
    setPortalUser(null);
    setClient(null);
    window.location.hash = '#/client-portal';
  };

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center" style={{ background: 'var(--gradient-page)' }}>
        <div className="w-8 h-8 border-2 border-purple-400 border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  if (!client || !portalUser) {
    return <ClientPortalLogin onLoggedIn={loadPortalSession} />;
  }

  return <ClientPortalView client={client} onSignOut={handleSignOut} />;
}
