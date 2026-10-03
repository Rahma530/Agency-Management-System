import {StrictMode, useEffect, useState} from 'react';
import {createRoot} from 'react-dom/client';
import App from './App.tsx';
import ClientPortalApp from './ClientPortalApp.tsx';
import {InvitePage} from './components/InvitePage.tsx';
import './index.css';

type Route = 'client-portal' | 'invite' | 'app';

function resolveRoute(): Route {
  const hash = window.location.hash;
  if (hash.startsWith('#/client-portal')) return 'client-portal';
  if (hash.startsWith('#/invite')) return 'invite';
  return 'app';
}

// Three fully separate trees, chosen once by URL and never mixed: App.tsx owns the employee
// session lifecycle end to end, ClientPortalApp.tsx owns the client one (see its own comment for
// why they can't share a root), and InvitePage.tsx is a standalone, no-side-effect landing page for
// admin-generated employee invitation links (see its own comment for why that link can't just be
// shared as a raw Supabase URL).
function Root() {
  const [route, setRoute] = useState<Route>(resolveRoute);

  useEffect(() => {
    const onHashChange = () => setRoute(resolveRoute());
    window.addEventListener('hashchange', onHashChange);
    return () => window.removeEventListener('hashchange', onHashChange);
  }, []);

  if (route === 'client-portal') return <ClientPortalApp />;
  if (route === 'invite') return <InvitePage />;
  return <App />;
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Root />
  </StrictMode>,
);
