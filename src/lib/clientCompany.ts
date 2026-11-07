// Which of the agency's own sibling companies (Kesra, Fast Growth, Top Rate) a client belongs to.
// Owner decision, 2026-11-07: purely organizational/display grouping, never an access boundary —
// every employee who can already see a client keeps seeing it regardless of this field. See
// 20270102000000_client_company.sql for the column/constraint.
//
// NOT the same concept as ClientRecord.is_inhouse (src/lib/clientStatus.ts's isInhouseClient) —
// is_inhouse marks the two special client ROWS that represent the agency's own internal,
// non-billable work (one literally named "Kesraa", one "Fast Growth"). This `company` field is
// about which sibling company a REAL, billable, external client belongs to — an entirely separate
// classification that happens to share the "Fast Growth" name with one of those two internal rows.
import { ClientRecord } from '../types/database';

export type ClientCompanyId = 'kesra' | 'fast_growth' | 'top_rate';

// Adding a 4th company later: add one entry here, and extend ClientCompanyId above plus the check
// constraint in a new migration (clients_company_known_check) — same two-place-edit convention
// ClientSector already uses (SECTOR_OPTIONS + clients_sector_check).
export const CLIENT_COMPANY_OPTIONS: { value: ClientCompanyId; label: string }[] = [
  { value: 'kesra', label: 'Kesra' },
  { value: 'fast_growth', label: 'Fast Growth' },
  { value: 'top_rate', label: 'Top Rate' },
];

export const getClientCompanyLabel = (company?: string | null): string => {
  if (!company) return 'Unassigned';
  return CLIENT_COMPANY_OPTIONS.find((opt) => opt.value === company)?.label || company;
};

export const getClientCompany = (client: Pick<ClientRecord, 'company'>): ClientCompanyId | null =>
  (client.company as ClientCompanyId | null | undefined) || null;
