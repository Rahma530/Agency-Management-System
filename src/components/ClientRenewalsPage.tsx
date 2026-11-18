// Client Renewals page (new, 2026-11-18 — see PR #327 and follow-ups).
//
// A dedicated financial/collections view, separate from AMQueue's existing status-based Renewal
// Queue: this page lists every client whose renewal_date falls within the next 7 days (the
// agreed advance-notice window), shows the value/paid/remaining for the CURRENT renewal cycle
// (clients.renewal_value vs the sum of client_renewal_payments for that cycle — never a
// separately-edited number), and is where a payment toward that renewal actually gets logged
// (channel, screenshot, optional new contract). Clients with money still owed are visually
// flagged; a client with nothing owed renders like any other row again, automatically, the
// moment a payment covers it.
//
// Deliberately reuses existing infrastructure rather than re-deriving it: clients.renewal_date/
// renewal_history_count, client_renewal_events (confirm_client_renewal's own history), and
// getClientServices/getRenewalTeamSize for the team-size column.

import React, { useMemo, useState } from 'react';
import { AlertTriangle, Calendar, Filter, Upload, Users as UsersIcon } from 'lucide-react';
import {
  ClientRecord,
  ClientRenewalPaymentRecord,
  RenewalEmployeeTargetRecord,
  RenewalPaymentChannel,
  ServiceType,
  UserRecord,
} from '../types/database';
import { getClientServices, SERVICE_LABELS } from '../lib/clientServices';
import { getRenewalTeamSize } from '../lib/renewalTeamSizes';

const PAYMENT_CHANNEL_LABELS: Record<RenewalPaymentChannel, string> = {
  mahdy: 'مهدي',
  masry: 'مصري',
  tabby: 'تابي',
  tamara: 'تمارا',
  kesra: 'كسرة',
};

const DURATION_OPTIONS: { value: 1 | 3 | 6 | 12; label: string }[] = [
  { value: 1, label: 'شهر' },
  { value: 3, label: '3 شهور' },
  { value: 6, label: '6 شهور' },
  { value: 12, label: 'سنة' },
];

const CORE_SERVICE_FILTERS: ServiceType[] = ['seo', 'social_media', 'media_buying', 'interface', 'creation'];

interface ClientRenewalsPageProps {
  clients: ClientRecord[];
  clientRenewalPayments: ClientRenewalPaymentRecord[];
  renewalEmployeeTargets: RenewalEmployeeTargetRecord[];
  users: UserRecord[];
  currentUser: UserRecord;
  canManageTargets: boolean;
  onRecordRenewalPayment: (
    clientId: string,
    input: {
      renewalValue: number;
      amountPaid: number;
      paymentChannel: RenewalPaymentChannel;
      renewalDurationMonths: 1 | 3 | 6 | 12;
      transferScreenshot: File;
      newContract?: File | null;
    }
  ) => Promise<void>;
  onSetEmployeeTarget: (employeeId: string, month: string, targetValue: number) => Promise<void>;
  onAddClientWithSameData?: (sourceClient: ClientRecord) => void;
}

const currentMonthKey = () => new Date().toISOString().slice(0, 7); // "2026-11"

const cycleSequence = (client: ClientRecord) => (client.renewal_history_count ?? 0) + 1;

export const ClientRenewalsPage: React.FC<ClientRenewalsPageProps> = ({
  clients,
  clientRenewalPayments,
  renewalEmployeeTargets,
  users,
  currentUser,
  canManageTargets,
  onRecordRenewalPayment,
  onSetEmployeeTarget,
  onAddClientWithSameData,
}) => {
  const [dateFrom, setDateFrom] = useState('');
  const [dateTo, setDateTo] = useState('');
  const [serviceFilter, setServiceFilter] = useState<ServiceType | ''>('');
  const [paymentClientId, setPaymentClientId] = useState<string | null>(null);

  const in7Days = useMemo(() => {
    const now = new Date();
    const end = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);
    return { now, end };
  }, []);

  const dueClients = useMemo(() => {
    return clients.filter((c) => {
      if (!c.renewal_date || c.status === 'closed') return false;
      const renewal = new Date(c.renewal_date);
      if (Number.isNaN(renewal.getTime())) return false;

      // Default window: within the next 7 days (the agreed advance-notice period). An explicit
      // date filter from the bar above replaces this default rather than narrowing it further —
      // the user is deliberately looking outside the usual 7-day window at that point.
      if (dateFrom || dateTo) {
        if (dateFrom && renewal < new Date(dateFrom)) return false;
        if (dateTo && renewal > new Date(dateTo)) return false;
      } else if (renewal < in7Days.now || renewal > in7Days.end) {
        return false;
      }

      if (serviceFilter && !getClientServices(c).includes(serviceFilter)) return false;

      return true;
    });
  }, [clients, dateFrom, dateTo, serviceFilter, in7Days]);

  const paidForCycle = (client: ClientRecord) => {
    const seq = cycleSequence(client);
    return clientRenewalPayments
      .filter((p) => p.client_id === client.id && p.renewal_sequence === seq)
      .reduce((sum, p) => sum + p.amount_paid, 0);
  };

  const remainingForCycle = (client: ClientRecord) => {
    if (client.renewal_value == null) return null;
    return Math.max(0, client.renewal_value - paidForCycle(client));
  };

  // Employee totals/target for the current calendar month — achieved is always derived from the
  // payment ledger (never stored), summing every payment THAT employee recorded this month
  // regardless of which client/cycle it belongs to.
  const month = currentMonthKey();
  const employeeStats = useMemo(() => {
    const achievedByEmployee = new Map<string, number>();
    clientRenewalPayments
      .filter((p) => p.payment_date.slice(0, 7) === month)
      .forEach((p) => {
        achievedByEmployee.set(p.recorded_by, (achievedByEmployee.get(p.recorded_by) || 0) + p.amount_paid);
      });

    const employeeIds = new Set([
      ...achievedByEmployee.keys(),
      ...renewalEmployeeTargets.filter((t) => t.month.slice(0, 7) === month).map((t) => t.employee_id),
    ]);

    return Array.from(employeeIds).map((employeeId) => {
      const user = users.find((u) => u.id === employeeId);
      const target = renewalEmployeeTargets.find((t) => t.employee_id === employeeId && t.month.slice(0, 7) === month);
      return {
        employeeId,
        name: user?.name || employeeId,
        achieved: achievedByEmployee.get(employeeId) || 0,
        target: target?.target_value ?? null,
      };
    });
  }, [clientRenewalPayments, renewalEmployeeTargets, users, month]);

  const paymentClient = paymentClientId ? clients.find((c) => c.id === paymentClientId) : null;

  return (
    <div className="space-y-6" dir="rtl">
      {/* الفلاتر */}
      <div className="flex flex-wrap items-center gap-3 p-4 rounded-xl border border-purple-900/30 bg-[#161224]/80">
        <Filter className="w-4 h-4 text-stone-400" />
        <label className="flex items-center gap-1.5 text-xs text-stone-400">
          من
          <input
            type="date"
            value={dateFrom}
            onChange={(e) => setDateFrom(e.target.value)}
            className="px-2 py-1 rounded-lg text-xs bg-stone-900/60 border border-stone-700/50 text-stone-200"
          />
        </label>
        <label className="flex items-center gap-1.5 text-xs text-stone-400">
          إلى
          <input
            type="date"
            value={dateTo}
            onChange={(e) => setDateTo(e.target.value)}
            className="px-2 py-1 rounded-lg text-xs bg-stone-900/60 border border-stone-700/50 text-stone-200"
          />
        </label>
        <select
          value={serviceFilter}
          onChange={(e) => setServiceFilter(e.target.value as ServiceType | '')}
          className="px-2 py-1 rounded-lg text-xs bg-stone-900/60 border border-stone-700/50 text-stone-200"
        >
          <option value="">كل الخدمات</option>
          {CORE_SERVICE_FILTERS.map((s) => (
            <option key={s} value={s}>
              {SERVICE_LABELS[s]}
            </option>
          ))}
        </select>
        {!dateFrom && !dateTo && (
          <span className="text-[11px] text-stone-500 flex items-center gap-1">
            <Calendar className="w-3 h-3" /> افتراضيًا: تجديدات خلال أسبوع
          </span>
        )}
      </div>

      {/* لستة العملاء */}
      <div className="rounded-xl border border-purple-900/30 bg-[#161224]/80 overflow-hidden">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-right text-xs text-stone-400 border-b border-purple-900/30">
              <th className="p-3">العميل</th>
              <th className="p-3">تاريخ التجديد</th>
              <th className="p-3">قيمة التجديد</th>
              <th className="p-3">المدفوع</th>
              <th className="p-3">المتبقي</th>
              <th className="p-3">عدد الموظفين</th>
              <th className="p-3"></th>
            </tr>
          </thead>
          <tbody>
            {dueClients.map((client) => {
              const remaining = remainingForCycle(client);
              const hasRemaining = remaining != null && remaining > 0;
              const teamSize = getRenewalTeamSize(client);
              return (
                <tr
                  key={client.id}
                  className={`border-b border-purple-900/10 ${
                    hasRemaining ? 'bg-amber-950/20' : ''
                  }`}
                >
                  <td className="p-3 font-bold text-stone-200">
                    {client.name}
                    {hasRemaining && (
                      <AlertTriangle className="inline-block w-3.5 h-3.5 text-amber-400 mr-1.5" />
                    )}
                  </td>
                  <td className="p-3 text-stone-300 font-mono text-xs">{client.renewal_date}</td>
                  <td className="p-3 text-stone-200 font-mono">
                    {client.renewal_value != null ? client.renewal_value.toLocaleString() : '—'}
                  </td>
                  <td className="p-3 text-emerald-400 font-mono">{paidForCycle(client).toLocaleString()}</td>
                  <td className={`p-3 font-mono ${hasRemaining ? 'text-amber-400 font-bold' : 'text-stone-400'}`}>
                    {remaining != null ? remaining.toLocaleString() : '—'}
                  </td>
                  <td className="p-3 text-stone-300">
                    {teamSize != null ? (
                      <span className="inline-flex items-center gap-1 text-xs">
                        <UsersIcon className="w-3 h-3" /> {teamSize}
                      </span>
                    ) : (
                      '—'
                    )}
                  </td>
                  <td className="p-3 flex items-center gap-2">
                    <button
                      onClick={() => setPaymentClientId(client.id)}
                      className="px-2.5 py-1 rounded-lg text-[11px] font-bold text-purple-200 bg-purple-900/40 hover:bg-purple-800/60"
                    >
                      تسجيل دفعة
                    </button>
                    {onAddClientWithSameData && (
                      <button
                        onClick={() => onAddClientWithSameData(client)}
                        className="px-2.5 py-1 rounded-lg text-[11px] font-bold text-stone-300 bg-stone-800/60 hover:bg-stone-700/60"
                      >
                        + عميل بنفس البيانات
                      </button>
                    )}
                  </td>
                </tr>
              );
            })}
            {dueClients.length === 0 && (
              <tr>
                <td colSpan={7} className="p-6 text-center text-stone-500 text-xs">
                  لا يوجد عملاء مستحقين للتجديد في الفترة المحددة.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {/* أداء الموظفين */}
      <div className="rounded-xl border border-purple-900/30 bg-[#161224]/80 p-4">
        <h3 className="text-sm font-bold text-stone-200 mb-3">أداء الموظفين هذا الشهر</h3>
        <table className="w-full text-sm">
          <thead>
            <tr className="text-right text-xs text-stone-400 border-b border-purple-900/20">
              <th className="p-2">الموظف</th>
              <th className="p-2">الإجمالي المحقق</th>
              <th className="p-2">التارجت</th>
              {canManageTargets && <th className="p-2">تعديل التارجت</th>}
            </tr>
          </thead>
          <tbody>
            {employeeStats.map((row) => (
              <EmployeeTargetRow
                key={row.employeeId}
                row={row}
                month={month}
                canManageTargets={canManageTargets}
                onSetEmployeeTarget={onSetEmployeeTarget}
              />
            ))}
            {employeeStats.length === 0 && (
              <tr>
                <td colSpan={canManageTargets ? 4 : 3} className="p-4 text-center text-stone-500 text-xs">
                  لا يوجد بيانات لهذا الشهر بعد.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {paymentClient && (
        <RecordPaymentModal
          client={paymentClient}
          onClose={() => setPaymentClientId(null)}
          onSubmit={async (input) => {
            await onRecordRenewalPayment(paymentClient.id, input);
            setPaymentClientId(null);
          }}
        />
      )}
    </div>
  );
};

const EmployeeTargetRow: React.FC<{
  row: { employeeId: string; name: string; achieved: number; target: number | null };
  month: string;
  canManageTargets: boolean;
  onSetEmployeeTarget: (employeeId: string, month: string, targetValue: number) => Promise<void>;
}> = ({ row, month, canManageTargets, onSetEmployeeTarget }) => {
  const [draft, setDraft] = useState(row.target != null ? String(row.target) : '');
  const [isSaving, setIsSaving] = useState(false);

  const handleSave = async () => {
    const value = Number(draft);
    if (!draft || Number.isNaN(value) || value < 0) return;
    setIsSaving(true);
    try {
      await onSetEmployeeTarget(row.employeeId, `${month}-01`, value);
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <tr className="border-b border-purple-900/10">
      <td className="p-2 text-stone-200">{row.name}</td>
      <td className="p-2 text-emerald-400 font-mono">{row.achieved.toLocaleString()}</td>
      <td className="p-2 text-stone-300 font-mono">{row.target != null ? row.target.toLocaleString() : '—'}</td>
      {canManageTargets && (
        <td className="p-2 flex items-center gap-2">
          <input
            type="number"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            className="w-24 px-2 py-1 rounded-lg text-xs bg-stone-900/60 border border-stone-700/50 text-stone-200"
          />
          <button
            onClick={handleSave}
            disabled={isSaving}
            className="px-2 py-1 rounded-lg text-[11px] font-bold text-emerald-200 bg-emerald-900/40 hover:bg-emerald-800/60 disabled:opacity-50"
          >
            {isSaving ? '...' : 'حفظ'}
          </button>
        </td>
      )}
    </tr>
  );
};

const RecordPaymentModal: React.FC<{
  client: ClientRecord;
  onClose: () => void;
  onSubmit: (input: {
    renewalValue: number;
    amountPaid: number;
    paymentChannel: RenewalPaymentChannel;
    renewalDurationMonths: 1 | 3 | 6 | 12;
    transferScreenshot: File;
    newContract?: File | null;
  }) => Promise<void>;
}> = ({ client, onClose, onSubmit }) => {
  const [renewalValue, setRenewalValue] = useState(client.renewal_value != null ? String(client.renewal_value) : '');
  const [amountPaid, setAmountPaid] = useState('');
  const [paymentChannel, setPaymentChannel] = useState<RenewalPaymentChannel>('kesra');
  const [duration, setDuration] = useState<1 | 3 | 6 | 12>(1);
  const [screenshot, setScreenshot] = useState<File | null>(null);
  const [newContract, setNewContract] = useState<File | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState('');

  const handleSubmit = async () => {
    const valueNum = Number(renewalValue);
    const paidNum = Number(amountPaid);
    if (!renewalValue || Number.isNaN(valueNum) || valueNum <= 0) {
      setError('قيمة التجديد مطلوبة.');
      return;
    }
    if (!amountPaid || Number.isNaN(paidNum) || paidNum <= 0) {
      setError('المبلغ المدفوع مطلوب.');
      return;
    }
    if (!screenshot) {
      setError('صورة التحويل مطلوبة.');
      return;
    }
    setError('');
    setIsSaving(true);
    try {
      await onSubmit({
        renewalValue: valueNum,
        amountPaid: paidNum,
        paymentChannel,
        renewalDurationMonths: duration,
        transferScreenshot: screenshot,
        newContract,
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'حدث خطأ أثناء تسجيل الدفعة.');
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4" dir="rtl">
      <div className="w-full max-w-md rounded-xl border border-purple-900/40 bg-[#1a1530] p-5 space-y-3">
        <h3 className="text-sm font-bold text-stone-200">تسجيل دفعة تجديد — {client.name}</h3>

        <label className="block text-xs text-stone-400">
          قيمة التجديد
          <input
            type="number"
            value={renewalValue}
            onChange={(e) => setRenewalValue(e.target.value)}
            className="w-full mt-1 px-2 py-1.5 rounded-lg text-sm bg-stone-900/60 border border-stone-700/50 text-stone-200"
          />
        </label>

        <label className="block text-xs text-stone-400">
          المبلغ المدفوع الآن
          <input
            type="number"
            value={amountPaid}
            onChange={(e) => setAmountPaid(e.target.value)}
            className="w-full mt-1 px-2 py-1.5 rounded-lg text-sm bg-stone-900/60 border border-stone-700/50 text-stone-200"
          />
        </label>

        <label className="block text-xs text-stone-400">
          الجهة المدفوع لها
          <select
            value={paymentChannel}
            onChange={(e) => setPaymentChannel(e.target.value as RenewalPaymentChannel)}
            className="w-full mt-1 px-2 py-1.5 rounded-lg text-sm bg-stone-900/60 border border-stone-700/50 text-stone-200"
          >
            {(Object.keys(PAYMENT_CHANNEL_LABELS) as RenewalPaymentChannel[]).map((c) => (
              <option key={c} value={c}>
                {PAYMENT_CHANNEL_LABELS[c]}
              </option>
            ))}
          </select>
        </label>

        <label className="block text-xs text-stone-400">
          مدة التجديد
          <select
            value={duration}
            onChange={(e) => setDuration(Number(e.target.value) as 1 | 3 | 6 | 12)}
            className="w-full mt-1 px-2 py-1.5 rounded-lg text-sm bg-stone-900/60 border border-stone-700/50 text-stone-200"
          >
            {DURATION_OPTIONS.map((opt) => (
              <option key={opt.value} value={opt.value}>
                {opt.label}
              </option>
            ))}
          </select>
        </label>

        <label className="block text-xs text-stone-400">
          صورة التحويل (مطلوبة)
          <input
            type="file"
            accept="image/*,application/pdf"
            onChange={(e) => setScreenshot(e.target.files?.[0] || null)}
            className="w-full mt-1 text-xs text-stone-300"
          />
        </label>

        <label className="block text-xs text-stone-400">
          عقد جديد (إن وجد)
          <input
            type="file"
            accept="image/*,application/pdf,.doc,.docx"
            onChange={(e) => setNewContract(e.target.files?.[0] || null)}
            className="w-full mt-1 text-xs text-stone-300"
          />
        </label>

        {error && <p className="text-xs text-rose-400">{error}</p>}

        <div className="flex items-center justify-end gap-2 pt-2">
          <button onClick={onClose} className="px-3 py-1.5 rounded-lg text-xs text-stone-300 bg-stone-800/60">
            إلغاء
          </button>
          <button
            onClick={handleSubmit}
            disabled={isSaving}
            className="px-3 py-1.5 rounded-lg text-xs font-bold text-white bg-purple-700 hover:bg-purple-600 disabled:opacity-50 flex items-center gap-1.5"
          >
            {isSaving ? '...' : <><Upload className="w-3.5 h-3.5" /> تسجيل الدفعة</>}
          </button>
        </div>
      </div>
    </div>
  );
};
