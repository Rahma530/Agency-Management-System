import {StrictMode, useEffect, useState} from 'react';
import {createRoot} from 'react-dom/client';
import App from './App.tsx';
import ClientPortalApp from './ClientPortalApp.tsx';
import './index.css';

// Two fully separate trees, chosen once by URL and never mixed: App.tsx owns the employee
// session lifecycle end to end, ClientPortalApp.tsx owns the client one — see
// ClientPortalApp.tsx's own comment for why they can't share a root.
function Root() {
  const [isClientPortal, setIsClientPortal] = useState(() => window.location.hash.startsWith('#/client-portal'));

  useEffect(() => {
    const onHashChange = () => setIsClientPortal(window.location.hash.startsWith('#/client-portal'));
    window.addEventListener('hashchange', onHashChange);
    return () => window.removeEventListener('hashchange', onHashChange);
  }, []);

  return isClientPortal ? <ClientPortalApp /> : <App />;
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Root />
  </StrictMode>,
);
