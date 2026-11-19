// AM Renewal — offline test harness (2026-11-19).
//
// Lets the owner click through every AM Renewal feature (tabs, Register Event menu, the Renewal/
// New Client/Upsell flows, the anchored popovers, the role-based scoping, the employee target
// panel) without touching Supabase at all: no login, no real client records, no real money
// figures, no elevated role needed. Every client/user/payment here is invented, and every action
// (record a payment, set a target, add an upsell, "register" a new client) only ever updates
// an in-memory array in this file — nothing is sent anywhere, nothing is read from anywhere.
//
// Run locally with `npm run dev` and open /renewals-demo.html. Deliberately NOT wired into
// vite.config.ts's build input, so it never ships as part of the production bundle — this page
// only exists for `npm run dev`.

import React, { useState } from 'react';
import { ClientRenewalsPage } from '../components/ClientRenewalsPage';
import type {
  ClientRecord,
  ClientRenewalPaymentRecord,
  RenewalEmployeeTargetRecord,
  RenewalPaymentChannel,
  ServiceType,
  UserRecord,
} from '../types/database';

// --- Fake users -------------------------------------------------------------------------------
const FAKE_USERS: UserRecord[] = [
  { id: 'demo-agent-1', name: 'Sara Ahmed (AM Agent)', role: 'am_agent', manager_id: 'demo-tl-1', auth_id: 'x' },
  { id: 'demo-agent-2', name: 'Omar Hassan (AM Agent)', role: 'am_agent', manager_id: 'demo-tl-1', auth_id: 'x' },
  { id: 'demo-agent-3', name: 'Mona Khaled (AM Agent, different TL)', role: 'am_agent', manager_id: 'demo-tl-2', auth_id: 'x' },
  { id: 'demo-tl-1', name: 'Laila Fathy (AM Team Lead)', role: 'am_team_lead', auth_id: 'x' },
  { id: 'demo-tl-2', name: 'Hossam Said (AM Team Lead)', role: 'am_team_lead', auth_id: 'x' },
  { id: 'demo-exec-1', name: 'Nourhan Adel (Executive)', role: 'executive', auth_id: 'x' },
];

const VIEW_AS_OPTIONS: { id: string; label: string }[] = [
  { id: 'demo-agent-1', label: 'Sara — AM Agent' },
  { id: 'demo-agent-2', label: 'Omar — AM Agent (same team as Sara)' },
  { id: 'demo-agent-3', label: 'Mona — AM Agent (different team)' },
  { id: 'demo-tl-1', label: "Laila — AM Team Lead (Sara & Omar's manager)" },
  { id: 'demo-exec-1', label: 'Nourhan — Executive (sees everyone)' },
];

// --- Fake clients -------------------------------------------------------------------------------
const today = new Date();
const dateInCurrentMonth = (day: number) => {
  const d = new Date(today.getFullYear(), today.getMonth(), Math.min(day, 28));
  return d.toISOString().slice(0, 10);
};
const dateInOtherMonth = () => {
  const d = new Date(today.getFullYear(), today.getMonth() + 2, 10);
  return d.toISOString().slice(0, 10);
};

const makeClient = (overrides: Partial<ClientRecord> & { id: string; name: string }): ClientRecord => ({
  services: ['seo'],
  other_services: [],
  status: 'active',
  ...overrides,
});

const initialClients: ClientRecord[] = [
  makeClient({
    id: 'demo-client-1',
    name: 'Golden Collagen Co. (fake)',
    am_agent_id: 'demo-agent-1',
    am_renewal_registered_by: 'demo-agent-1',
    services: ['seo', 'social_media', 'media_buying'],
    other_services: ['interface'],
    contract_value: 1400,
    contract_duration_months: 3,
    renewal_date: dateInCurrentMonth(17),
    renewal_history_count: 0,
  }),
  makeClient({
    id: 'demo-client-2',
    name: 'Wave Studio (fake)',
    am_agent_id: 'demo-agent-1',
    am_renewal_registered_by: null, // Sales-registered, just assigned to Sara — should still show
    services: ['media_buying'],
    contract_value: 1500,
    contract_duration_months: 1,
    renewal_date: dateInCurrentMonth(10),
    renewal_history_count: 2,
  }),
  makeClient({
    id: 'demo-client-3',
    name: 'Dora Kids Wear (fake)',
    am_agent_id: 'demo-agent-1',
    am_renewal_registered_by: 'demo-agent-1',
    services: ['seo'],
    contract_value: 1500,
    contract_duration_months: 6,
    renewal_date: dateInCurrentMonth(20),
    renewal_history_count: 0,
  }),
  makeClient({
    id: 'demo-client-4',
    name: 'Tuwaiq Stars (fake, no contract value on file)',
    am_agent_id: 'demo-agent-2',
    am_renewal_registered_by: null,
    services: ['social_media'],
    contract_value: null,
    contract_duration_months: null,
    renewal_date: dateInCurrentMonth(25),
    renewal_history_count: 0,
  }),
  makeClient({
    id: 'demo-client-5',
    name: 'Ghmar Line (fake)',
    am_agent_id: 'demo-agent-2',
    am_renewal_registered_by: 'demo-agent-2',
    services: ['seo', 'social_media', 'media_buying'],
    contract_value: 8000,
    contract_duration_months: 12,
    renewal_date: dateInCurrentMonth(15),
    renewal_history_count: 1,
  }),
  makeClient({
    id: 'demo-client-6',
    name: 'Mazyoona Oud (fake, not due this month)',
    am_agent_id: 'demo-agent-2',
    am_renewal_registered_by: 'demo-agent-2',
    services: ['media_buying'],
    contract_value: 1500,
    contract_duration_months: 3,
    renewal_date: dateInOtherMonth(),
    renewal_history_count: 0,
  }),
  makeClient({
    id: 'demo-client-7',
    name: "Mona's Client — Cherie Avenue (fake, different team)",
    am_agent_id: 'demo-agent-3',
    am_renewal_registered_by: 'demo-agent-3',
    services: ['seo', 'social_media', 'media_buying'],
    other_services: ['interface'],
    contract_value: 2200,
    contract_duration_months: 3,
    renewal_date: dateInCurrentMonth(25),
    renewal_history_count: 0,
  }),
  makeClient({
    id: 'demo-client-8',
    name: 'Sales-only Client (fake, no am_agent — should never show here)',
    am_agent_id: null,
    sales_owner_id: 'demo-sales-1',
    services: ['seo'],
    contract_value: 900,
    renewal_date: dateInCurrentMonth(12),
  }),
];

const initialPayments: ClientRenewalPaymentRecord[] = [
  {
    id: 'demo-payment-1',
    client_id: 'demo-client-2',
    renewal_sequence: 3,
    renewal_value: 1500,
    amount_paid: 1500,
    payment_channel: 'kesra',
    payment_date: dateInCurrentMonth(10),
    renewal_duration_months: 1,
    transfer_screenshot_path: 'demo/fake-screenshot.png',
    recorded_by: 'demo-agent-1',
    created_at: new Date().toISOString(),
  },
];

const initialTargets: RenewalEmployeeTargetRecord[] = [
  {
    id: 'demo-target-1',
    employee_id: 'demo-agent-1',
    month: dateInCurrentMonth(1),
    target_value: 10000,
    set_by: 'demo-tl-1',
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  },
];

let fakeIdCounter = 1;
const nextFakeId = (prefix: string) => `${prefix}-${Date.now()}-${fakeIdCounter++}`;

export const RenewalsDemo: React.FC = () => {
  const [viewAsId, setViewAsId] = useState('demo-agent-1');
  const [clients, setClients] = useState<ClientRecord[]>(initialClients);
  const [payments, setPayments] = useState<ClientRenewalPaymentRecord[]>(initialPayments);
  const [targets, setTargets] = useState<RenewalEmployeeTargetRecord[]>(initialTargets);
  const [log, setLog] = useState<string[]>([]);

  const currentUser = FAKE_USERS.find((u) => u.id === viewAsId)!;
  const canManageTargets = ['executive', 'head_of_technical', 'am_team_lead'].includes(currentUser.role);

  const appendLog = (line: string) => setLog((prev) => [`${new Date().toLocaleTimeString()} — ${line}`, ...prev].slice(0, 20));

  const handleRecordRenewalPayment = async (
    clientId: string,
    input: {
      renewalValue: number;
      amountPaid: number;
      paymentChannel: RenewalPaymentChannel;
      renewalDurationMonths: 1 | 3 | 6 | 12;
      transferScreenshot: File;
      nextRenewalDate: string;
      newContract?: File | null;
    }
  ) => {
    const client = clients.find((c) => c.id === clientId);
    if (!client) return;
    const sequence = (client.renewal_history_count ?? 0) + 1;
    setPayments((prev) => [
      ...prev,
      {
        id: nextFakeId('demo-payment'),
        client_id: clientId,
        renewal_sequence: sequence,
        renewal_value: input.renewalValue,
        amount_paid: input.amountPaid,
        payment_channel: input.paymentChannel,
        payment_date: new Date().toISOString().slice(0, 10),
        renewal_duration_months: input.renewalDurationMonths,
        transfer_screenshot_path: `demo/${input.transferScreenshot.name}`,
        new_contract_path: input.newContract ? `demo/${input.newContract.name}` : null,
        recorded_by: currentUser.id,
        created_at: new Date().toISOString(),
      },
    ]);
    setClients((prev) =>
      prev.map((c) => (c.id === clientId ? { ...c, renewal_value: input.renewalValue, renewal_date: input.nextRenewalDate } : c))
    );
    appendLog(`Recorded a ${input.amountPaid.toLocaleString()} payment for "${client.name}" (fake, nothing sent anywhere).`);
  };

  const handleSetEmployeeTarget = async (employeeId: string, month: string, targetValue: number) => {
    setTargets((prev) => {
      const existing = prev.find((t) => t.employee_id === employeeId && t.month === month);
      if (existing) return prev.map((t) => (t === existing ? { ...t, target_value: targetValue } : t));
      return [
        ...prev,
        {
          id: nextFakeId('demo-target'),
          employee_id: employeeId,
          month,
          target_value: targetValue,
          set_by: currentUser.id,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        },
      ];
    });
    appendLog(`Set a ${targetValue.toLocaleString()} target for ${employeeId} (fake, local only).`);
  };

  const handleRecordUpsell = async (
    clientId: string,
    patch: { services: ServiceType[]; other_services: string[]; renewal_value?: number }
  ) => {
    setClients((prev) =>
      prev.map((c) =>
        c.id === clientId
          ? {
              ...c,
              services: patch.services,
              other_services: patch.other_services,
              renewal_value: patch.renewal_value ?? c.renewal_value,
            }
          : c
      )
    );
    const client = clients.find((c) => c.id === clientId);
    appendLog(`Added an upsell to "${client?.name}" (fake, local only).`);
  };

  const handleOpenNewClientEvent = () => {
    const name = window.prompt('Fake "New Client" form — just type a client name to simulate registering them:');
    if (!name) return;
    const id = nextFakeId('demo-client');
    setClients((prev) => [
      ...prev,
      makeClient({
        id,
        name: `${name} (fake, just added)`,
        am_agent_id: currentUser.id,
        am_renewal_registered_by: currentUser.id,
        services: ['seo'],
        contract_value: 1000,
        contract_duration_months: 3,
        renewal_date: dateInCurrentMonth(today.getDate()),
        renewal_history_count: 0,
      }),
    ]);
    appendLog(`Registered a fake new client "${name}" under ${currentUser.name} (local only — this is where the real app opens the full registration form).`);
  };

  return (
    <div className="min-h-screen bg-[#0d0a16] text-stone-200 p-6">
      <div className="max-w-6xl mx-auto space-y-5">
        <div className="rounded-2xl border border-amber-500/30 bg-amber-500/10 p-4 text-sm">
          <p className="font-bold text-amber-300">AM Renewal — offline test harness</p>
          <p className="text-amber-200/80 mt-1">
            Every client, user, and payment on this page is fake and only lives in your browser's memory. No
            Supabase connection, no real client data, no real money figures, no login or role needed — refreshing
            the page resets everything.
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2 p-3 rounded-2xl border border-purple-900/20 bg-[#161224]/80">
          <span className="text-xs text-stone-400 mr-1">View as:</span>
          {VIEW_AS_OPTIONS.map((opt) => (
            <button
              key={opt.id}
              onClick={() => setViewAsId(opt.id)}
              className={`px-3 py-1.5 rounded-lg text-xs font-bold transition-colors ${
                viewAsId === opt.id ? 'bg-purple-600 text-white' : 'bg-stone-900/50 text-stone-300 hover:bg-stone-800/60'
              }`}
            >
              {opt.label}
            </button>
          ))}
        </div>

        <ClientRenewalsPage
          clients={clients}
          clientRenewalPayments={payments}
          renewalEmployeeTargets={targets}
          users={FAKE_USERS}
          currentUser={currentUser}
          canManageTargets={canManageTargets}
          onRecordRenewalPayment={handleRecordRenewalPayment}
          onSetEmployeeTarget={handleSetEmployeeTarget}
          onRecordUpsell={handleRecordUpsell}
          onOpenNewClientEvent={handleOpenNewClientEvent}
        />

        {log.length > 0 && (
          <div className="rounded-2xl border border-purple-900/20 bg-[#161224]/80 p-4">
            <p className="text-xs font-bold text-stone-300 mb-2">Actions log (this session only):</p>
            <ul className="space-y-1 text-[11px] text-stone-400 font-mono">
              {log.map((line, i) => (
                <li key={i}>{line}</li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </div>
  );
};
