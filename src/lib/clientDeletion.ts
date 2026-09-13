import { supabase } from './supabase';

// Every table that references clients(id) — all 13 default to ON DELETE NO ACTION at the DB
// level (unchanged from the canonical schema), so a delete already fails outright if any of these
// has a row. This list exists purely so the app can show WHICH ones before the user even tries,
// rather than surfacing a raw Postgres foreign-key-violation error.
const CLIENT_ACTIVITY_TABLES: { table: string; label: string }[] = [
  { table: 'tasks', label: 'Tasks' },
  { table: 'briefs', label: 'Briefs' },
  { table: 'campaigns', label: 'Campaigns' },
  { table: 'assignments', label: 'Assignments' },
  { table: 'client_comparisons', label: 'Client Comparisons' },
  { table: 'reports', label: 'Reports' },
  { table: 'client_contracts', label: 'Contracts' },
  { table: 'client_portal_users', label: 'Client Portal Logins' },
  { table: 'meetings', label: 'Meetings' },
  { table: 'social_insights', label: 'Social Insights' },
  { table: 'analytics_insights', label: 'Analytics Insights' },
  { table: 'platform_connections', label: 'Platform Connections' },
  { table: 'daily_logs', label: 'Daily Logs' },
];

export interface ClientActivitySummaryRow {
  table: string;
  label: string;
  count: number;
}

// Only the non-zero rows are returned — a client with zero activity everywhere gets an empty
// array back, which is the one case a hard delete can actually succeed for.
export async function getClientActivitySummary(clientId: string): Promise<ClientActivitySummaryRow[]> {
  const results = await Promise.all(
    CLIENT_ACTIVITY_TABLES.map(async ({ table, label }) => {
      const { count, error } = await supabase
        .from(table)
        .select('id', { count: 'exact', head: true })
        .eq('client_id', clientId);
      if (error) {
        console.error(`Error counting ${table} for client activity check:`, error);
        return { table, label, count: 0 };
      }
      return { table, label, count: count || 0 };
    })
  );
  return results.filter((r) => r.count > 0);
}
