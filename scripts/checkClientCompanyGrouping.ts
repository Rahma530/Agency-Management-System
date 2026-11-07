// Static checks for the client-company grouping feature requested 2026-11-07: "فيه شركات خارجة
// منها زي Fast Growth و Top Rate و فيه Clients متسجلة على ال System تابعين ليهم" — a new
// `company` field (Kesra/Fast Growth/Top Rate) on public.clients, display/organization only (the
// owner confirmed, not an access boundary), with a filter (incl. an "Unassigned" bucket, since
// existing clients are NOT backfilled — see the migration's own note) on the Client Portfolio.
import fs from 'node:fs';
import { CLIENT_COMPANY_OPTIONS, getClientCompanyLabel, ClientCompanyId } from '../src/lib/clientCompany';

// 1) CLIENT_COMPANY_OPTIONS covers exactly the 3 known companies today, each with a human label.
const ids = CLIENT_COMPANY_OPTIONS.map((o) => o.value).sort();
if (JSON.stringify(ids) !== JSON.stringify(['fast_growth', 'kesra', 'top_rate'])) {
  throw new Error(`CLIENT_COMPANY_OPTIONS must list exactly kesra/fast_growth/top_rate, got: ${ids.join(', ')}`);
}

// 2) getClientCompanyLabel: known id -> its label; unset -> "Unassigned"; stale/unknown stored
// value (e.g. a company later removed from the option list) -> falls back to the raw value rather
// than silently hiding it, so a label never just disappears without a trace.
if (getClientCompanyLabel('kesra') !== 'Kesra') throw new Error('getClientCompanyLabel("kesra") must return "Kesra".');
if (getClientCompanyLabel(null) !== 'Unassigned') throw new Error('getClientCompanyLabel(null) must return "Unassigned".');
if (getClientCompanyLabel(undefined) !== 'Unassigned') throw new Error('getClientCompanyLabel(undefined) must return "Unassigned".');
if (getClientCompanyLabel('') !== 'Unassigned') throw new Error('getClientCompanyLabel("") must return "Unassigned".');
if (getClientCompanyLabel('some_retired_company') !== 'some_retired_company') {
  throw new Error('getClientCompanyLabel() must fall back to the raw stored value for an id not in CLIENT_COMPANY_OPTIONS, not silently hide it.');
}

// 3) ClientCompanyId's own exhaustiveness — a type-level check that fails to compile if a new
// company is added to CLIENT_COMPANY_OPTIONS without updating the type (or vice versa).
const typeCheck: ClientCompanyId[] = ['kesra', 'fast_growth', 'top_rate'];
void typeCheck;

// 4) ClientRegistrationModal: Company is a REQUIRED select (new registrations must be tagged from
// day one — only the existing portfolio is grandfathered as unassigned).
const registrationSrc = fs.readFileSync('src/components/ClientRegistrationModal.tsx', 'utf8');
if (!registrationSrc.includes("if (!company) {")) {
  throw new Error('ClientRegistrationModal must validate that a company was selected before submit.');
}
if (!registrationSrc.includes('company,\n          industry: industry.trim(),')) {
  throw new Error('ClientRegistrationModal must include company in the payload passed to onSubmit.');
}

// 5) EditClientModal: Company is editable but NOT required (existing clients may still be
// unassigned, and other edits must not be blocked on tagging a company first).
const editSrc = fs.readFileSync('src/components/EditClientModal.tsx', 'utf8');
if (editSrc.includes('Company <span className="text-red-400">*</span>')) {
  throw new Error('EditClientModal must NOT mark Company as required — existing clients are deliberately left unassigned until tagged by hand.');
}
if (!editSrc.includes('if ((company || null) !== (client.company || null)) patch.company = company || null;')) {
  throw new Error('EditClientModal must diff company against the loaded client and include it in the patch only when changed.');
}

// 6) AMQueue.tsx (Client Portfolio): a company filter exists, defaults to 'all', and has an
// explicit 'unassigned' bucket distinct from any real company id.
const amQueueSrc = fs.readFileSync('src/components/AMQueue.tsx', 'utf8');
if (!amQueueSrc.includes("useState<ClientCompanyId | 'all' | 'unassigned'>('all')")) {
  throw new Error('AMQueue.tsx must declare companyFilter defaulting to \'all\', alongside statusFilter.');
}
if (!amQueueSrc.includes("{ key: 'unassigned', label: 'Unassigned' }")) {
  throw new Error('AMQueue.tsx’s company filter must offer an explicit Unassigned bucket, or untagged existing clients become unfindable.');
}
if (!amQueueSrc.includes('companyFilter === \'all\' &&')) {
  throw new Error('canReorderClients must also require companyFilter === \'all\' — drag-reorder is only valid on the full, unfiltered list (same reasoning already applied to statusFilter).');
}

// 7) The SQL side: the migration that adds the column must NOT backfill a guessed value (the
// owner confirmed existing clients are already split across the three — a guess would mis-tag
// real clients), and update_client_details() must allow-list + validate 'company' or
// EditClientModal's save silently fails with "Unknown or disallowed field: company".
const columnMigration = fs.readFileSync('supabase/migrations/20270102000000_client_company.sql', 'utf8');
if (/update\s+public\.clients\s+set\s+company\s*=/i.test(columnMigration)) {
  throw new Error('The company column migration must not backfill any value — which company owns which existing client is only known to the owner, not inferable from existing data.');
}
if (!columnMigration.includes('grant select (company) on public.clients to authenticated;')) {
  throw new Error('The company column migration must grant SELECT on the new column — public.clients has a column-level (not blanket) SELECT grant, and a missing grant here breaks the ENTIRE client fetch for everyone (see 20261209000000_grant_profit_margin_pct_select.sql’s postmortem).');
}

const rpcMigration = fs.readFileSync('supabase/migrations/20270102100000_update_client_details_add_company.sql', 'utf8');
if (!rpcMigration.includes("'company',")) {
  throw new Error('update_client_details() must add \'company\' to v_allowed_keys, or every EditClientModal save that includes it is rejected with "Unknown or disallowed field: company".');
}
if (!rpcMigration.includes("v_company is not null and v_company not in ('kesra', 'fast_growth', 'top_rate')")) {
  throw new Error('update_client_details() must validate company against the same known set as the DB check constraint, so a bad value is rejected with a clear error instead of hitting the constraint with an opaque one.');
}
if (!rpcMigration.includes('company = case when p_patch ? \'company\' then v_company else company end,')) {
  throw new Error('update_client_details()’s UPDATE statement must actually write v_company back to the company column.');
}

console.log('OK: client-company grouping (Kesra/Fast Growth/Top Rate) is wired through the type, the shared options list, Register (required) and Edit (optional) forms, the Client Portfolio’s filter (with an Unassigned bucket and reorder-safety), and both migrations (no guessed backfill, full SELECT grant, and the update_client_details() allow-list/validation/write-back).');
