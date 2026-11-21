// Entry point for the AM Renewal offline test harness (src/dev/RenewalsDemo.tsx) — see that
// file's own comment for what it is and isn't. Deliberately separate from main.tsx so this never
// touches real auth/Supabase state, and deliberately not included in vite.config.ts's build input
// so `npm run build` never ships it — this only runs via `npm run dev` + /renewals-demo.html.

import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { RenewalsDemo } from './dev/RenewalsDemo.tsx';
import './index.css';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <RenewalsDemo />
  </StrictMode>,
);
