import React, { useMemo, useRef, useState } from 'react';
import Papa from 'papaparse';
import * as XLSX from 'xlsx';
import { X, Download, FileSpreadsheet, Upload, AlertCircle, Loader2, UploadCloud } from 'lucide-react';
import { ClientRecord, ClientSector, ServiceType, UserRecord } from '../types/database';
import { isActiveEmployee } from '../lib/permissions';
import { normalizeClientServices } from '../lib/clientServices';

interface BulkClientUploadModalProps {
  isOpen: boolean;
  onClose: () => void;
  currentUser: UserRecord;
  users: UserRecord[];
  clients: ClientRecord[];
  onAddClientRow: (client: {
    name: string;
    client_contact_name?: string;
    sector?: ClientSector;
    industry: string;
    services: ServiceType[];
    phone_number?: string;
    website_or_social_link?: string;
    contract_value: number;
    due_value?: number;
    remaining_value?: number;
    start_date: string;
    renewal_date: string;
    am_team_lead_id?: string;
    am_agent_id?: string;
  }) => Promise<void>;
}

const VALID_SERVICES = [
  'seo', 'social_media', 'media_buying', 'interface', 'واجهة',
  'creation', 'إنشاء', 'branding', 'الهوية البصرية', 'هوية',
  'comprehensive', 'شاملة', 'creative',
];
const isValidService = (val: string): boolean => VALID_SERVICES.includes(val);
const normalizeSector = (value: string): ClientSector | null => {
  const normalized = value.trim().toLowerCase();
  if (normalized === 'e-commerce') return 'E-Commerce';
  if (normalized === 'service') return 'Service';
  return null;
};
const isValidDateStr = (val: string) => !Number.isNaN(new Date(val).getTime());
const todayIso = () => new Date().toISOString().split('T')[0];
const addOneYear = (dateStr: string): string => {
  const d = new Date(dateStr);
  if (Number.isNaN(d.getTime())) return dateStr;
  d.setFullYear(d.getFullYear() + 1);
  return d.toISOString().split('T')[0];
};

const CSV_TEMPLATE_HEADERS = [
  'name',
  'client_contact_name',
  'sector',
  'industry',
  'services',
  'contract_value',
  'due_value',
  'remaining_value',
  'start_date',
  'renewal_date',
  'phone_number',
  'website_or_social_link',
  'am_team_lead_name',
];
const MANAGEMENT_TEMPLATE_HEADERS = [...CSV_TEMPLATE_HEADERS, 'am_agent_name'];
const CSV_TEMPLATE_EXAMPLE = [
  'Apex Global Trading',
  'Khaled',
  'E-Commerce',
  'عطور/بخور',
  'seo;media_buying',
  '5000',
  '',
  '',
  '',
  '',
  '+966 50 123 4567',
  'https://apexglobal.example.com',
  'مها الشامي',
];

type RowStatus = 'added' | 'skipped' | 'failed';
interface RowResult {
  row: number;
  name: string;
  status: RowStatus;
  reason?: string;
}

// Normalizes whatever papaparse/xlsx hands back into plain string-keyed rows, lowercasing
// headers so "Name"/"name"/"NAME" all match — mirrors EmployeeAdminHub's bulk uploader.
const normalizeRows = (rawRows: Record<string, any>[]): Record<string, string>[] =>
  rawRows.map((raw) => {
    const normalized: Record<string, string> = {};
    for (const key of Object.keys(raw)) {
      normalized[key.trim().toLowerCase()] = String(raw[key] ?? '').trim();
    }
    return normalized;
  });

const parseFile = (file: File): Promise<Record<string, string>[]> => {
  const isCsv = file.name.toLowerCase().endsWith('.csv');
  if (isCsv) {
    return new Promise((resolve, reject) => {
      Papa.parse<Record<string, any>>(file, {
        header: true,
        skipEmptyLines: true,
        complete: (results) => resolve(normalizeRows(results.data)),
        error: (err) => reject(err),
      });
    });
  }
  return file.arrayBuffer().then((buffer) => {
    const workbook = XLSX.read(buffer, { type: 'array' });
    const firstSheet = workbook.Sheets[workbook.SheetNames[0]];
    const rows = XLSX.utils.sheet_to_json<Record<string, any>>(firstSheet, { defval: '' });
    return normalizeRows(rows);
  });
};

export const BulkClientUploadModal: React.FC<BulkClientUploadModalProps> = ({
  isOpen,
  onClose,
  currentUser,
  users,
  clients,
  onAddClientRow,
}) => {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [isProcessingFile, setIsProcessingFile] = useState(false);
  const [results, setResults] = useState<RowResult[] | null>(null);
  const [fileError, setFileError] = useState<string | null>(null);

  // Sales and AM Agent retain a required AM lead; management may leave both AM assignments empty.
  const isSalesUpload = currentUser.role === 'sales';
  const isLeadershipUpload = currentUser.role === 'executive' || currentUser.role === 'head_of_technical';
  const isManagementUpload = isLeadershipUpload || currentUser.role === 'am_team_lead';

  const amTeamLeads = useMemo(
    () => users.filter((u) => u.role === 'am_team_lead' && isActiveEmployee(u)),
    [users]
  );
  const amAgents = useMemo(() => users.filter((u) => u.role === 'am_agent' && isActiveEmployee(u)), [users]);

  // Duplicate detection has no unique DB constraint to lean on (clients has no email column) —
  // purely a client-side name+phone_number heuristic, same combination requested for this
  // feature. Two different companies that share a name and both leave phone_number blank will
  // collide here; that's a known limitation of this key, not a bug.
  const existingClientKeys = useMemo(
    () =>
      new Set(
        clients.map((c) => `${(c.name || '').trim().toLowerCase()}|${(c.phone_number || '').trim().toLowerCase()}`)
      ),
    [clients]
  );

  if (!isOpen) return null;

  const downloadTemplate = () => {
    const headers = isManagementUpload ? MANAGEMENT_TEMPLATE_HEADERS : CSV_TEMPLATE_HEADERS;
    const example = isManagementUpload ? [...CSV_TEMPLATE_EXAMPLE, ''] : CSV_TEMPLATE_EXAMPLE;
    const csv = [headers.join(','), example.join(',')].join('\n');
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'client_upload_template.csv';
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  };

  const handleFileSelect = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;

    setFileError(null);
    setResults(null);
    setIsProcessingFile(true);

    try {
      const rows = await parseFile(file);
      if (rows.length === 0) {
        setFileError('That file has no data rows.');
        return;
      }

      const seenKeysThisFile = new Set<string>();
      const rowResults: RowResult[] = [];

      // Row-by-row, not batched: one bad/duplicate row is skipped and reported without aborting
      // the rest of the file, same pattern as the employee bulk uploader.
      for (let i = 0; i < rows.length; i++) {
        const rowNum = i + 2; // +1 for 1-indexing, +1 for the header row
        const raw = rows[i];
        const rowName = (raw.name || '').trim();
        const rowContactName = (raw.client_contact_name || '').trim();
        const rowSector = (raw.sector || '').trim();
        const rowIndustry = (raw.industry || '').trim();
        const rowServicesRaw = (raw.services || '').trim();
        const rowContractValue = (raw.contract_value || '').trim();
        const rowDueValue = (raw.due_value || '').trim();
        const rowRemainingValue = (raw.remaining_value || '').trim();
        const rowStartDate = (raw.start_date || '').trim();
        const rowRenewalDate = (raw.renewal_date || '').trim();
        const rowPhone = (raw.phone_number || '').trim();
        const rowWebsiteOrSocial = (raw.website_or_social_link || '').trim();
        const rowAmLeadName = (raw.am_team_lead_name || '').trim();
        const rowAmAgentName = (raw.am_agent_name || '').trim();

        if (!rowName) {
          rowResults.push({ row: rowNum, name: rowName, status: 'skipped', reason: 'Missing name' });
          continue;
        }

        if (!rowServicesRaw) {
          rowResults.push({ row: rowNum, name: rowName, status: 'skipped', reason: 'Missing services' });
          continue;
        }
        const sector = rowSector ? normalizeSector(rowSector) : null;
        if (rowSector && !sector) {
          rowResults.push({ row: rowNum, name: rowName, status: 'skipped', reason: 'Invalid sector (valid: E-Commerce, Service)' });
          continue;
        }
        // Semicolon is the recommended delimiter (a CSV cell already uses comma as the field
        // separator, so a comma-separated list needs quoting to survive — semicolon needs none);
        // comma is still accepted here for files where that quoting was done correctly, or that
        // came from Excel/Sheets where the cell content isn't re-split by the outer parser.
        const serviceTokens = rowServicesRaw
          .split(/[,;]/)
          .map((s) => s.trim().toLowerCase())
          .filter(Boolean);
        const invalidTokens = serviceTokens.filter((s) => !isValidService(s));
        if (serviceTokens.length === 0 || invalidTokens.length > 0) {
          rowResults.push({
            row: rowNum,
            name: rowName,
            status: 'skipped',
            reason: `Invalid services "${rowServicesRaw}" (valid: seo, social_media, media_buying, interface, creation, branding, comprehensive / شاملة)`,
          });
          continue;
        }
        const services = normalizeClientServices(serviceTokens);

        if (rowContractValue && Number.isNaN(Number(rowContractValue))) {
          rowResults.push({ row: rowNum, name: rowName, status: 'skipped', reason: 'contract_value is not a number' });
          continue;
        }
        const contractValue = rowContractValue ? Number(rowContractValue) : 0;

        if (rowDueValue && Number.isNaN(Number(rowDueValue))) {
          rowResults.push({ row: rowNum, name: rowName, status: 'skipped', reason: 'due_value is not a number' });
          continue;
        }
        const dueValue = rowDueValue ? Number(rowDueValue) : undefined;

        if (rowRemainingValue && Number.isNaN(Number(rowRemainingValue))) {
          rowResults.push({ row: rowNum, name: rowName, status: 'skipped', reason: 'remaining_value is not a number' });
          continue;
        }
        const remainingValue = rowRemainingValue ? Number(rowRemainingValue) : undefined;

        if (rowStartDate && !isValidDateStr(rowStartDate)) {
          rowResults.push({ row: rowNum, name: rowName, status: 'skipped', reason: 'start_date is not a valid date' });
          continue;
        }
        const startDate = rowStartDate || todayIso();

        if (rowRenewalDate && !isValidDateStr(rowRenewalDate)) {
          rowResults.push({ row: rowNum, name: rowName, status: 'skipped', reason: 'renewal_date is not a valid date' });
          continue;
        }
        const renewalDate = rowRenewalDate || addOneYear(startDate);

        if (!rowAmLeadName && !isManagementUpload) {
          rowResults.push({ row: rowNum, name: rowName, status: 'skipped', reason: 'Missing am_team_lead_name' });
          continue;
        }
        // First case-insensitive name match wins; two active AM Team Leads sharing a name would
        // silently resolve to whichever comes first in `users`. Not handled specially since role
        // names are set by leadership at hire time and collisions are expected to be rare/caught
        // elsewhere, same trust level manager_id gets in the employee bulk uploader.
        const matchedLead = rowAmLeadName ? amTeamLeads.find((u) => u.name.trim().toLowerCase() === rowAmLeadName.toLowerCase()) : null;
        if (rowAmLeadName && !matchedLead) {
          rowResults.push({
            row: rowNum,
            name: rowName,
            status: 'skipped',
            reason: `No active AM Team Lead named "${rowAmLeadName}"`,
          });
          continue;
        }
        const matchedAgent = rowAmAgentName && isManagementUpload
          ? amAgents.find((u) => u.name.trim().toLowerCase() === rowAmAgentName.toLowerCase()) : null;
        if (rowAmAgentName && isManagementUpload && !matchedAgent) {
          rowResults.push({ row: rowNum, name: rowName, status: 'skipped', reason: `No active AM Agent named "${rowAmAgentName}"` });
          continue;
        }

        const dupKey = `${rowName.toLowerCase()}|${rowPhone.toLowerCase()}`;
        if (existingClientKeys.has(dupKey) || seenKeysThisFile.has(dupKey)) {
          rowResults.push({ row: rowNum, name: rowName, status: 'skipped', reason: 'Duplicate name + phone_number' });
          continue;
        }

        seenKeysThisFile.add(dupKey);
        try {
          await onAddClientRow({
            name: rowName,
            client_contact_name: rowContactName || undefined,
            sector: sector || undefined,
            industry: rowIndustry || 'General',
            services,
            phone_number: rowPhone || undefined,
            website_or_social_link: rowWebsiteOrSocial || undefined,
            contract_value: contractValue,
            due_value: dueValue,
            remaining_value: remainingValue,
            start_date: startDate,
            renewal_date: renewalDate,
            am_team_lead_id: matchedLead?.id,
            am_agent_id: matchedAgent?.id,
          });
          rowResults.push({ row: rowNum, name: rowName, status: 'added' });
        } catch (err: any) {
          rowResults.push({ row: rowNum, name: rowName, status: 'failed', reason: err?.message || 'Insert failed' });
        }
      }

      setResults(rowResults);
    } catch (err: any) {
      setFileError(err?.message || 'Unable to parse this file. Confirm it\'s a valid .csv or .xlsx file.');
    } finally {
      setIsProcessingFile(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/80 backdrop-blur-sm" dir="ltr">
      <div
        className="w-full max-w-2xl rounded-[20px] p-6 shadow-2xl relative overflow-hidden font-sans"
        style={{ background: 'var(--gradient-card)', border: '1px solid var(--border-medium)' }}
      >
        <div className="flex items-center justify-between pb-4 mb-5 border-b" style={{ borderColor: 'var(--border-soft)' }}>
          <div className="flex items-center gap-3">
            <div
              className="w-10 h-10 rounded-[12px] flex items-center justify-center text-black"
              style={{ background: 'linear-gradient(135deg, #fbbf24, #f59e0b)', border: '1px solid var(--border-strong)' }}
            >
              <UploadCloud className="w-5 h-5" />
            </div>
            <div>
              <h3 className="text-lg font-bold" style={{ color: 'var(--white)' }}>
                Bulk Upload Clients
              </h3>
              <p className="text-xs" style={{ color: 'var(--grey)' }}>
                {isSalesUpload
                  ? 'Every row is registered under your name and routed to Account Management, same as a single registration.'
                  : isManagementUpload
                    ? 'Every row is registered for onboarding; AM assignments may be supplied now or later.'
                    : 'Every row is added as an already-active client under your management — no sales handoff, no onboarding stage.'}
              </p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="p-1.5 rounded-lg text-stone-400 hover:text-white transition-colors"
            style={{ background: 'rgba(255, 255, 255, 0.05)' }}
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="space-y-4">
          <div className="flex items-center justify-between flex-wrap gap-2">
            <p className="text-xs text-stone-400">
              Columns: <code className="font-mono">{(isManagementUpload ? MANAGEMENT_TEMPLATE_HEADERS : CSV_TEMPLATE_HEADERS).join(', ')}</code>
              <br />
              Required: name, services{isManagementUpload ? '.' : ', am_team_lead_name.'} Everything else is optional.
            </p>
            <button
              onClick={downloadTemplate}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[11px] font-bold text-amber-200 bg-amber-900/30 hover:bg-amber-800/50 hover:text-white border border-amber-700/40 transition-all shrink-0"
            >
              <Download className="w-3.5 h-3.5" />
              Download CSV Template
            </button>
          </div>

          <input ref={fileInputRef} type="file" accept=".csv,.xlsx,.xls" onChange={handleFileSelect} className="hidden" />
          <button
            onClick={() => fileInputRef.current?.click()}
            disabled={isProcessingFile}
            className="w-full flex flex-col items-center justify-center gap-2 py-8 rounded-xl border-2 border-dashed border-amber-700/40 hover:border-amber-500/60 transition-all disabled:opacity-50"
          >
            {isProcessingFile ? (
              <Loader2 className="w-6 h-6 text-amber-400 animate-spin" />
            ) : (
              <FileSpreadsheet className="w-6 h-6 text-amber-400" />
            )}
            <span className="text-xs font-bold text-white">
              {isProcessingFile ? 'Processing...' : 'Click to select a .csv or .xlsx file'}
            </span>
            <span className="text-[11px] text-stone-500 flex items-center gap-1">
              <Upload className="w-3 h-3" /> Rows are inserted one at a time — a bad row is skipped and reported, not fatal.
            </span>
          </button>

          {fileError && (
            <div
              className="p-3 rounded-xl text-xs flex items-center gap-2"
              style={{ background: 'rgba(245,163,163,0.12)', color: 'var(--roas-bad)', border: '1px solid var(--roas-bad)' }}
            >
              <AlertCircle className="w-3.5 h-3.5 shrink-0" />
              {fileError}
            </div>
          )}

          {results && (
            <div className="space-y-2">
              <div className="flex gap-3 text-[11px]">
                <span className="text-emerald-400 font-bold">{results.filter((r) => r.status === 'added').length} added</span>
                <span className="text-amber-400 font-bold">{results.filter((r) => r.status === 'skipped').length} skipped</span>
                <span className="text-red-400 font-bold">{results.filter((r) => r.status === 'failed').length} failed</span>
              </div>
              <div className="max-h-72 overflow-y-auto rounded-xl border border-amber-900/30 custom-scrollbar">
                <table className="w-full text-[11px]">
                  <thead className="sticky top-0 bg-[#1a1428]">
                    <tr className="text-left text-stone-400">
                      <th className="px-3 py-2">Row</th>
                      <th className="px-3 py-2">Name</th>
                      <th className="px-3 py-2">Status</th>
                      <th className="px-3 py-2">Reason</th>
                    </tr>
                  </thead>
                  <tbody>
                    {results.map((r) => (
                      <tr key={r.row} className="border-t border-amber-900/20">
                        <td className="px-3 py-1.5 text-stone-500 font-mono">{r.row}</td>
                        <td className="px-3 py-1.5 text-white">{r.name || '—'}</td>
                        <td className="px-3 py-1.5">
                          <span
                            className={`px-2 py-0.5 rounded-full text-[10px] font-bold ${
                              r.status === 'added'
                                ? 'text-emerald-400 bg-emerald-500/10'
                                : r.status === 'skipped'
                                ? 'text-amber-400 bg-amber-500/10'
                                : 'text-red-400 bg-red-500/10'
                            }`}
                          >
                            {r.status}
                          </span>
                        </td>
                        <td className="px-3 py-1.5 text-stone-400">{r.reason || '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
