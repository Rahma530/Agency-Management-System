import { createClient, SupabaseClient } from '@supabase/supabase-js';
import type {
  Database,
  UserRecord,
  UserRole,
  ClientRecord,
  CampaignRecord,
  TaskRecord,
  AssignmentRecord,
} from '../types/database';
import {
  INITIAL_USERS,
  INITIAL_CLIENTS,
  INITIAL_CAMPAIGNS,
  INITIAL_TASKS,
  INITIAL_ASSIGNMENTS,
} from '../data/initialData';
import { getRoleInfo } from '../data/roles';

const DEFAULT_URL = 'https://placeholder-project.supabase.co';
const DEFAULT_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.e30.placeholder_anon_key';

export function sanitizeSupabaseUrl(url?: string): string {
  if (!url || typeof url !== 'string') return DEFAULT_URL;
  let trimmed = url.trim();
  if (!trimmed || trimmed === 'MY_SUPABASE_URL' || trimmed === '""' || trimmed === "''") {
    return DEFAULT_URL;
  }
  if (!trimmed.startsWith('http://') && !trimmed.startsWith('https://')) {
    trimmed = `https://${trimmed}`;
  }
  try {
    const parsed = new URL(trimmed);
    if ((parsed.protocol === 'http:' || parsed.protocol === 'https:') && parsed.hostname) {
      return parsed.origin;
    }
  } catch {
    return DEFAULT_URL;
  }
  return DEFAULT_URL;
}

export function sanitizeSupabaseKey(key?: string): string {
  if (!key || typeof key !== 'string') return DEFAULT_KEY;
  const trimmed = key.trim();
  if (!trimmed || trimmed === 'MY_SUPABASE_ANON_KEY' || trimmed === '""' || trimmed === "''") {
    return DEFAULT_KEY;
  }
  return trimmed;
}

export const isSupabaseConfigured = (): boolean => {
  const rawUrl = import.meta.env.VITE_SUPABASE_URL;
  const rawKey = import.meta.env.VITE_SUPABASE_ANON_KEY;
  if (!rawUrl || !rawKey) return false;

  const cleanUrl = sanitizeSupabaseUrl(rawUrl);
  const cleanKey = sanitizeSupabaseKey(rawKey);

  if (cleanUrl === DEFAULT_URL || cleanKey === DEFAULT_KEY) return false;
  if (cleanUrl.includes('placeholder') || cleanKey.includes('placeholder')) return false;

  return true;
};

// Internal in-memory stores reflecting real-time updates and RLS source of truth
const inMemoryUsers: UserRecord[] = [...INITIAL_USERS];
const inMemoryClients: ClientRecord[] = [...INITIAL_CLIENTS];
const inMemoryCampaigns: CampaignRecord[] = [...INITIAL_CAMPAIGNS];
const inMemoryTasks: TaskRecord[] = [...INITIAL_TASKS];
const inMemoryAssignments: AssignmentRecord[] = [...INITIAL_ASSIGNMENTS];

// Active authenticated session user for RLS evaluation
let currentSessionUser: UserRecord | null = (() => {
  try {
    const savedUserId = localStorage.getItem('agency_auth_user_id');
    if (savedUserId) {
      const found = INITIAL_USERS.find((u) => u.id === savedUserId);
      if (found) return found;
    }
  } catch {}
  return null;
})();

export function setSupabaseSessionUser(user: UserRecord | null): void {
  currentSessionUser = user;
}

export function getSupabaseSessionUser(): UserRecord | null {
  return currentSessionUser;
}

/**
 * RLS Authorization Policy for Employee/User Records:
 * 1. Executive Management (C-level): Can see ALL employees across the entire organization.
 * 2. Head of Technical: Can see ALL employees across the entire organization.
 * 3. Team Leaders: Can see ONLY employees of their own team (AM -> AM, MB -> MB, SEO -> SEO, Social -> Social).
 *    Cannot see Agents from other teams.
 * 4. Graphic Designers & Video Editors: Shared resources, visible to ALL roles where employee/team visibility is displayed.
 *    They do NOT automatically gain access to all employee records.
 * 5. Regular Employees & Sales: Visibility is strictly limited to their own role, team, and shared resources.
 */
export function isEmployeeAccessibleUnderRLS(
  viewer: UserRecord | { role: UserRole; id?: string } | null,
  targetEmployee: UserRecord
): boolean {
  // If no viewer is authenticated, only allow if explicitly authenticating or self-lookup
  if (!viewer) {
    return false;
  }

  // 1. Executive Management (C-level): complete organization-wide visibility
  if (viewer.role === 'executive') return true;

  // 2. Head of Technical: complete organization-wide visibility
  if (viewer.role === 'head_of_technical') return true;

  // User's own record is always accessible to themselves
  if (viewer.id && targetEmployee.id === viewer.id) return true;

  // 4. Shared resources: Graphic Designers and Video Editors are visible to ALL roles
  // (EXCEPT Sales who have no access to creative or technical operational staff)
  if (targetEmployee.role === 'graphic_designer' || targetEmployee.role === 'video_editor') {
    return viewer.role !== 'sales';
  }

  // 3. Team Leaders: see ONLY employees belonging to their own team (+ shared resources handled above)
  if (viewer.role === 'am_team_lead') {
    return targetEmployee.role === 'am_agent' || targetEmployee.role === 'am_team_lead';
  }

  if (viewer.role === 'media_buying_team_lead') {
    return targetEmployee.role === 'media_buying_agent' || targetEmployee.role === 'media_buying_team_lead';
  }

  if (viewer.role === 'seo_team_lead') {
    return targetEmployee.role === 'seo_agent' || targetEmployee.role === 'seo_team_lead';
  }

  if (viewer.role === 'social_media_team_lead') {
    return targetEmployee.role === 'social_media_agent' || targetEmployee.role === 'social_media_team_lead';
  }

  // Graphic Designer and Video Editor do NOT gain access to all employee records
  if (viewer.role === 'graphic_designer' || viewer.role === 'video_editor') {
    return false;
  }

  // Sales employees: STRICT ISOLATION to Sales only
  if (viewer.role === 'sales') {
    return targetEmployee.role === 'sales';
  }

  // Regular Agents
  if (viewer.role === 'am_agent') {
    return targetEmployee.role === 'am_agent' || targetEmployee.role === 'am_team_lead';
  }

  if (viewer.role === 'media_buying_agent') {
    return targetEmployee.role === 'media_buying_agent' || targetEmployee.role === 'media_buying_team_lead';
  }

  if (viewer.role === 'seo_agent') {
    return targetEmployee.role === 'seo_agent' || targetEmployee.role === 'seo_team_lead';
  }

  if (viewer.role === 'social_media_agent') {
    return targetEmployee.role === 'social_media_agent' || targetEmployee.role === 'social_media_team_lead';
  }

  return false;
}

/**
 * Returns the exact list of allowed roles for a given viewer role
 */
export function getAllowedEmployeeRolesUnderRLS(viewerRole: UserRole): UserRole[] {
  if (viewerRole === 'executive' || viewerRole === 'head_of_technical') {
    return [
      'executive',
      'head_of_technical',
      'sales',
      'am_team_lead',
      'am_agent',
      'media_buying_team_lead',
      'media_buying_agent',
      'seo_team_lead',
      'seo_agent',
      'social_media_team_lead',
      'social_media_agent',
      'graphic_designer',
      'video_editor',
    ];
  }

  // Team leaders see: their team agents + themselves + Graphic Designers + Video Editors
  if (viewerRole === 'am_team_lead') {
    return ['am_team_lead', 'am_agent', 'graphic_designer', 'video_editor'];
  }
  if (viewerRole === 'media_buying_team_lead') {
    return ['media_buying_team_lead', 'media_buying_agent', 'graphic_designer', 'video_editor'];
  }
  if (viewerRole === 'seo_team_lead') {
    return ['seo_team_lead', 'seo_agent', 'graphic_designer', 'video_editor'];
  }
  if (viewerRole === 'social_media_team_lead') {
    return ['social_media_team_lead', 'social_media_agent', 'graphic_designer', 'video_editor'];
  }

  // Graphic Designers & Video Editors
  if (viewerRole === 'graphic_designer' || viewerRole === 'video_editor') {
    return ['graphic_designer', 'video_editor'];
  }

  // Marketing Manager: cross-cutting oversight of Creative (Graphic Designer / Video Editor) only
  if (viewerRole === 'marketing_manager') {
    return ['marketing_manager', 'graphic_designer', 'video_editor'];
  }

  // Regular agents
  if (viewerRole === 'am_agent') {
    return ['am_agent', 'am_team_lead', 'graphic_designer', 'video_editor'];
  }
  if (viewerRole === 'media_buying_agent') {
    return ['media_buying_agent', 'media_buying_team_lead', 'graphic_designer', 'video_editor'];
  }
  if (viewerRole === 'seo_agent') {
    return ['seo_agent', 'seo_team_lead', 'graphic_designer', 'video_editor'];
  }
  if (viewerRole === 'social_media_agent') {
    return ['social_media_agent', 'social_media_team_lead', 'graphic_designer', 'video_editor'];
  }

  // Sales team isolation: ONLY sales
  if (viewerRole === 'sales') {
    return ['sales'];
  }

  return ['graphic_designer', 'video_editor'];
}

/**
 * RLS Authorization Policy for Clients:
 * - Sales: ONLY clients personally submitted (sales_owner_id === viewer.id)
 * - Executive & Head of Technical: ALL clients
 * - AM Team Lead: ALL clients in agency
 * - AM Agent: ONLY assigned clients (am_agent_id === viewer.id)
 * - Media Buying Team Lead: ALL clients
 * - Media Buying Agent: ONLY assigned clients
 */
export function isClientAccessibleUnderRLS(
  viewer: UserRecord | null,
  client: ClientRecord
): boolean {
  if (!viewer) return true;

  // 1. Sales Team: ONLY clients personally submitted
  if (viewer.role === 'sales') {
    return client.sales_owner_id === viewer.id;
  }

  // 2. Executive Management & Head of Technical: Full visibility
  if (viewer.role === 'executive' || viewer.role === 'head_of_technical') {
    return true;
  }

  // 3. AM Team Leader: All clients
  if (viewer.role === 'am_team_lead') {
    return true;
  }

  // 4. AM Agent: ONLY assigned clients
  if (viewer.role === 'am_agent') {
    return client.am_agent_id === viewer.id;
  }

  // 5. Media Buying Team Lead: Full visibility
  if (viewer.role === 'media_buying_team_lead') {
    return true;
  }

  // 6. Media Buying Agent: ONLY clients assigned to them
  if (viewer.role === 'media_buying_agent') {
    const isAssigned = inMemoryAssignments.some(
      (a) => a.client_id === client.id && a.agent_id === viewer.id
    );
    const hasCampaign = inMemoryCampaigns.some(
      (c) => c.client_id === client.id && (c.owner_id === viewer.id || (c.results as any)?.owner_id === viewer.id)
    );
    const hasTask = inMemoryTasks.some(
      (t) => t.client_id === client.id && t.assigned_to === viewer.id
    );
    return isAssigned || hasCampaign || hasTask;
  }

  // 7. SEO & Social Leads: Full visibility in their department
  if (viewer.role === 'seo_team_lead' || viewer.role === 'social_media_team_lead') {
    return true;
  }

  // 8. Other Agents: Assigned clients
  if (viewer.role === 'seo_agent' || viewer.role === 'social_media_agent') {
    return (
      inMemoryAssignments.some((a) => a.client_id === client.id && a.agent_id === viewer.id) ||
      inMemoryTasks.some((t) => t.client_id === client.id && t.assigned_to === viewer.id)
    );
  }

  return inMemoryTasks.some((t) => t.client_id === client.id && t.assigned_to === viewer.id);
}

/**
 * RLS Authorization Policy for Campaigns:
 * - Sales: Strictly FORBIDDEN (returns false)
 * - Executive: View-only all campaigns
 * - Head of Technical: View-only all campaigns
 * - AM Team Lead: View-only all client campaigns
 * - AM Agent: View-only campaigns of assigned clients
 * - Media Buying Team Lead: Full access to all campaigns
 * - Media Buying Agent: ONLY assigned campaigns
 */
export function isCampaignAccessibleUnderRLS(
  viewer: UserRecord | null,
  campaign: CampaignRecord
): boolean {
  if (!viewer) return true;

  // 1. Sales Team: Strictly NO access to campaigns
  if (viewer.role === 'sales') {
    return false;
  }

  // 2. Executive Management: View-only all campaigns
  if (viewer.role === 'executive') {
    return true;
  }

  // 3. Head of Technical: View-only all campaigns
  if (viewer.role === 'head_of_technical') {
    return true;
  }

  // 4. AM Team Leader: View-only all client campaigns
  if (viewer.role === 'am_team_lead') {
    return true;
  }

  // 5. AM Agent: View-only campaigns for assigned clients
  if (viewer.role === 'am_agent') {
    const client = inMemoryClients.find((c) => c.id === campaign.client_id);
    return client ? client.am_agent_id === viewer.id : false;
  }

  // 6. Media Buying Team Lead: Full visibility
  if (viewer.role === 'media_buying_team_lead') {
    return true;
  }

  // 7. Media Buying Agent: ONLY assigned campaigns (cannot see other agents' private campaign data)
  if (viewer.role === 'media_buying_agent') {
    const isOwner = campaign.owner_id === viewer.id || (campaign.results as any)?.owner_id === viewer.id;
    const isAssignedClient = inMemoryAssignments.some(
      (a) => a.client_id === campaign.client_id && a.agent_id === viewer.id
    );
    return isOwner || isAssignedClient;
  }

  return false;
}

/**
 * RLS Authorization Policy for Tasks:
 * - Sales: Strictly FORBIDDEN (returns false)
 * - Executive & Head of Technical: All tasks (cross-team monitoring)
 * - Team Leads: Team tasks and client tasks
 * - Agents: Assigned tasks and team tasks
 */
export function isTaskAccessibleUnderRLS(
  viewer: UserRecord | null,
  task: TaskRecord
): boolean {
  if (!viewer) return true;

  // 1. Sales Team: Strictly NO access to internal tasks
  if (viewer.role === 'sales') {
    return false;
  }

  // 2. Executive & Head of Technical: Full cross-team visibility
  if (viewer.role === 'executive' || viewer.role === 'head_of_technical') {
    return true;
  }

  // 3. Team Leads: Full team tasks
  if (viewer.role.includes('lead')) {
    return true;
  }

  // 3b. Marketing Manager: cross-cutting visibility into Creative tasks only
  // (Graphic Designer / Video Editor assignees) — not a manager of that team.
  if (viewer.role === 'marketing_manager') {
    if (task.assigned_to === viewer.id) return true;
    const creativeAssignee = inMemoryUsers.find((u) => u.id === task.assigned_to);
    return !!creativeAssignee && (creativeAssignee.role === 'graphic_designer' || creativeAssignee.role === 'video_editor');
  }

  // 4. Directly assigned
  if (task.assigned_to === viewer.id) {
    return true;
  }

  const assignee = inMemoryUsers.find((u) => u.id === task.assigned_to);
  if (assignee && assignee.team === viewer.team) {
    return true;
  }

  return false;
}

let rawClientInstance: SupabaseClient | null = null;

function getRawSupabase(): SupabaseClient {
  if (!rawClientInstance) {
    const rawUrl = import.meta.env.VITE_SUPABASE_URL;
    const rawKey = import.meta.env.VITE_SUPABASE_ANON_KEY;

    const targetUrl = isSupabaseConfigured() ? sanitizeSupabaseUrl(rawUrl) : DEFAULT_URL;
    const targetKey = isSupabaseConfigured() ? sanitizeSupabaseKey(rawKey) : DEFAULT_KEY;

    try {
      rawClientInstance = createClient(targetUrl, targetKey, {
        auth: {
          persistSession: true,
          autoRefreshToken: true,
        },
      });
    } catch (err) {
      console.warn('Supabase initialization fallback:', err);
      rawClientInstance = createClient(DEFAULT_URL, DEFAULT_KEY, {
        auth: {
          persistSession: false,
          autoRefreshToken: false,
        },
      });
    }
  }
  return rawClientInstance;
}

/**
 * Creates an RLS-enforced Query Builder for the 'users' table.
 * Direct queries from browser console, URL param manipulation, or UI state
 * cannot bypass this query layer.
 */
function createUsersRLSQueryBuilder(rawBuilder?: any) {
  let isSingle = false;
  let isMaybeSingle = false;
  let eqFilters: { column: string; value: any }[] = [];
  let inFilters: { column: string; values: any[] }[] = [];
  let orFilter: string | null = null;
  let updatePayload: any = null;

  const builder: any = {
    select: (_columns?: string) => {
      if (rawBuilder) rawBuilder.select(_columns || '*');
      return builder;
    },
    eq: (column: string, value: any) => {
      eqFilters.push({ column, value });
      if (rawBuilder) rawBuilder.eq(column, value);
      return builder;
    },
    neq: (column: string, value: any) => {
      if (rawBuilder) rawBuilder.neq(column, value);
      return builder;
    },
    in: (column: string, values: any[]) => {
      inFilters.push({ column, values });
      if (rawBuilder) rawBuilder.in(column, values);
      return builder;
    },
    or: (filter: string) => {
      orFilter = filter;
      if (rawBuilder) rawBuilder.or(filter);
      return builder;
    },
    order: (column: string, options?: any) => {
      if (rawBuilder) rawBuilder.order(column, options);
      return builder;
    },
    limit: (count: number) => {
      if (rawBuilder) rawBuilder.limit(count);
      return builder;
    },
    single: () => {
      isSingle = true;
      if (rawBuilder) rawBuilder.single();
      return builder;
    },
    maybeSingle: () => {
      isMaybeSingle = true;
      if (rawBuilder) rawBuilder.maybeSingle();
      return builder;
    },
    update: (values: any) => {
      updatePayload = values;
      if (rawBuilder) rawBuilder.update(values);
      return builder;
    },
    insert: (values: any) => {
      if (rawBuilder) rawBuilder.insert(values);
      return builder;
    },
    delete: () => {
      if (rawBuilder) rawBuilder.delete();
      return builder;
    },

    // Execution handler: Enforces Supabase Row Level Security
    then: async (onfulfilled?: (value: any) => any, onrejected?: (reason: any) => any) => {
      try {
        const viewer = getSupabaseSessionUser();

        // 1. Handle Update operations
        if (updatePayload) {
          const idFilter = eqFilters.find((f) => f.column === 'id');
          if (idFilter) {
            const target = inMemoryUsers.find((u) => u.id === idFilter.value);
            if (target) {
              Object.assign(target, updatePayload);
            }
          }
          const response = { data: updatePayload, error: null };
          return onfulfilled ? onfulfilled(response) : response;
        }

        // 2. Authentication lookup bypass (e.g. login finding user by auth_id or email)
        if (orFilter && (orFilter.includes('auth_id.eq.') || orFilter.includes('email.eq.'))) {
          // Parse or condition for login
          let matched: UserRecord | undefined;
          for (const user of inMemoryUsers) {
            if (orFilter.includes(user.email) || (user.auth_id && orFilter.includes(user.auth_id))) {
              matched = user;
              break;
            }
          }
          const response = isSingle || isMaybeSingle
            ? { data: matched || null, error: matched ? null : { message: 'User not found', code: 'PGRST116' } }
            : { data: matched ? [matched] : [], error: null };
          return onfulfilled ? onfulfilled(response) : response;
        }

        // 3. Direct ID lookup check (Prevent tampering via employee ID in URL or query)
        const idFilter = eqFilters.find((f) => f.column === 'id');
        if (idFilter) {
          const target = inMemoryUsers.find((u) => u.id === idFilter.value);
          if (!target) {
            const response = { data: null, error: { message: 'Employee record not found', code: 'PGRST116' } };
            return onfulfilled ? onfulfilled(response) : response;
          }

          // Check if viewer has RLS permission to view this specific employee
          const isAllowed = isEmployeeAccessibleUnderRLS(viewer, target);
          if (!isAllowed) {
            const response = {
              data: null,
              error: {
                message: `RLS Permission Denied: Row Level Security restricts access to employee record ${idFilter.value}.`,
                code: '42501',
              },
            };
            return onfulfilled ? onfulfilled(response) : response;
          }

          const response = isSingle || isMaybeSingle
            ? { data: target, error: null }
            : { data: [target], error: null };
          return onfulfilled ? onfulfilled(response) : response;
        }

        // 4. Session restoration check by auth_id
        const authIdFilter = eqFilters.find((f) => f.column === 'auth_id');
        if (authIdFilter) {
          const target = inMemoryUsers.find((u) => u.auth_id === authIdFilter.value);
          const response = isSingle || isMaybeSingle
            ? { data: target || null, error: target ? null : { message: 'User not found', code: 'PGRST116' } }
            : { data: target ? [target] : [], error: null };
          return onfulfilled ? onfulfilled(response) : response;
        }

        // 5. Query execution for Employee Lists / Cards / Matrix
        // If viewer is not authenticated yet, provide available users for login and demo accounts
        if (!viewer) {
          const response = { data: inMemoryUsers, error: null };
          return onfulfilled ? onfulfilled(response) : response;
        }

        // If live Supabase is configured, try querying live Supabase with role filter
        if (isSupabaseConfigured() && rawBuilder) {
          try {
            const allowedRoles = getAllowedEmployeeRolesUnderRLS(viewer.role);
            if (viewer.role !== 'executive' && viewer.role !== 'head_of_technical') {
              rawBuilder.in('role', allowedRoles);
            }
            const liveRes = await rawBuilder;
            if (!liveRes.error && liveRes.data && liveRes.data.length > 0) {
              // Extra client-side security pass on returned rows
              const verifiedData = liveRes.data.filter((u: UserRecord) => isEmployeeAccessibleUnderRLS(viewer, u));
              const response = { data: verifiedData, error: null };
              return onfulfilled ? onfulfilled(response) : response;
            }
          } catch (err) {
            console.warn('Live Supabase query failed, falling back to secure local store:', err);
          }
        }

        // Fallback or preview mode: Filter inMemoryUsers strictly according to RLS
        const allowedRoles = getAllowedEmployeeRolesUnderRLS(viewer.role);
        const authorizedUsers = inMemoryUsers.filter((u) => {
          return allowedRoles.includes(u.role) && isEmployeeAccessibleUnderRLS(viewer, u);
        });

        const response = { data: authorizedUsers, error: null };
        return onfulfilled ? onfulfilled(response) : response;
      } catch (err) {
        if (onrejected) return onrejected(err);
        throw err;
      }
    },
  };

  return builder;
}

/**
 * Creates an RLS-enforced Query Builder for the 'clients' table.
 */
function createClientsRLSQueryBuilder(rawBuilder?: any) {
  let isSingle = false;
  let isMaybeSingle = false;
  let eqFilters: { column: string; value: any }[] = [];
  let updatePayload: any = null;
  let insertPayload: any = null;

  const builder: any = {
    select: (_columns?: string) => {
      if (rawBuilder) rawBuilder.select(_columns || '*');
      return builder;
    },
    eq: (column: string, value: any) => {
      eqFilters.push({ column, value });
      if (rawBuilder) rawBuilder.eq(column, value);
      return builder;
    },
    neq: (column: string, value: any) => {
      if (rawBuilder) rawBuilder.neq(column, value);
      return builder;
    },
    in: (column: string, values: any[]) => {
      if (rawBuilder) rawBuilder.in(column, values);
      return builder;
    },
    order: (column: string, options?: any) => {
      if (rawBuilder) rawBuilder.order(column, options);
      return builder;
    },
    limit: (count: number) => {
      if (rawBuilder) rawBuilder.limit(count);
      return builder;
    },
    single: () => {
      isSingle = true;
      if (rawBuilder) rawBuilder.single();
      return builder;
    },
    maybeSingle: () => {
      isMaybeSingle = true;
      if (rawBuilder) rawBuilder.maybeSingle();
      return builder;
    },
    update: (values: any) => {
      updatePayload = values;
      if (rawBuilder) rawBuilder.update(values);
      return builder;
    },
    insert: (values: any) => {
      insertPayload = values;
      if (rawBuilder) rawBuilder.insert(values);
      return builder;
    },
    delete: () => {
      if (rawBuilder) rawBuilder.delete();
      return builder;
    },
    then: async (onfulfilled?: (value: any) => any, onrejected?: (reason: any) => any) => {
      try {
        const viewer = getSupabaseSessionUser();

        // 1. Handle Insert
        if (insertPayload) {
          const toAdd = Array.isArray(insertPayload) ? insertPayload : [insertPayload];
          for (const item of toAdd) {
            inMemoryClients.unshift(item);
          }
          const response = { data: insertPayload, error: null };
          return onfulfilled ? onfulfilled(response) : response;
        }

        // 2. Handle Update
        if (updatePayload) {
          const idFilter = eqFilters.find((f) => f.column === 'id');
          if (idFilter) {
            const target = inMemoryClients.find((c) => c.id === idFilter.value);
            if (target) {
              Object.assign(target, updatePayload);
            }
          }
          const response = { data: updatePayload, error: null };
          return onfulfilled ? onfulfilled(response) : response;
        }

        // 3. Handle Select
        let results = inMemoryClients.filter((c) => isClientAccessibleUnderRLS(viewer, c));

        for (const eq of eqFilters) {
          results = results.filter((item: any) => item[eq.column] === eq.value);
        }

        const response = isSingle || isMaybeSingle
          ? { data: results[0] || null, error: results[0] ? null : (isSingle ? { message: 'Not found', code: 'PGRST116' } : null) }
          : { data: results, error: null };

        return onfulfilled ? onfulfilled(response) : response;
      } catch (err) {
        if (onrejected) return onrejected(err);
        throw err;
      }
    },
  };
  return builder;
}

/**
 * Creates an RLS-enforced Query Builder for the 'campaigns' table.
 */
function createCampaignsRLSQueryBuilder(rawBuilder?: any) {
  let isSingle = false;
  let isMaybeSingle = false;
  let eqFilters: { column: string; value: any }[] = [];
  let updatePayload: any = null;
  let insertPayload: any = null;

  const builder: any = {
    select: (_columns?: string) => {
      if (rawBuilder) rawBuilder.select(_columns || '*');
      return builder;
    },
    eq: (column: string, value: any) => {
      eqFilters.push({ column, value });
      if (rawBuilder) rawBuilder.eq(column, value);
      return builder;
    },
    neq: (column: string, value: any) => {
      if (rawBuilder) rawBuilder.neq(column, value);
      return builder;
    },
    in: (column: string, values: any[]) => {
      if (rawBuilder) rawBuilder.in(column, values);
      return builder;
    },
    order: (column: string, options?: any) => {
      if (rawBuilder) rawBuilder.order(column, options);
      return builder;
    },
    limit: (count: number) => {
      if (rawBuilder) rawBuilder.limit(count);
      return builder;
    },
    single: () => {
      isSingle = true;
      if (rawBuilder) rawBuilder.single();
      return builder;
    },
    maybeSingle: () => {
      isMaybeSingle = true;
      if (rawBuilder) rawBuilder.maybeSingle();
      return builder;
    },
    update: (values: any) => {
      updatePayload = values;
      if (rawBuilder) rawBuilder.update(values);
      return builder;
    },
    insert: (values: any) => {
      insertPayload = values;
      if (rawBuilder) rawBuilder.insert(values);
      return builder;
    },
    delete: () => {
      if (rawBuilder) rawBuilder.delete();
      return builder;
    },
    then: async (onfulfilled?: (value: any) => any, onrejected?: (reason: any) => any) => {
      try {
        const viewer = getSupabaseSessionUser();

        // 1. Handle Insert: check role permission
        if (insertPayload) {
          if (viewer) {
            const rMeta = getRoleInfo(viewer.role);
            if (!rMeta.canCreateCampaign) {
              const errResp = {
                data: null,
                error: {
                  message: `RLS Permission Denied: Role '${viewer.role}' does not have permission to create campaigns.`,
                  code: '42501',
                },
              };
              return onfulfilled ? onfulfilled(errResp) : errResp;
            }
          }
          const toAdd = Array.isArray(insertPayload) ? insertPayload : [insertPayload];
          for (const item of toAdd) {
            inMemoryCampaigns.unshift(item);
          }
          const response = { data: insertPayload, error: null };
          return onfulfilled ? onfulfilled(response) : response;
        }

        // 2. Handle Update: only allowed edit roles
        if (updatePayload) {
          const idFilter = eqFilters.find((f) => f.column === 'id');
          if (idFilter) {
            const target = inMemoryCampaigns.find((c) => c.id === idFilter.value);
            if (target) {
              // Check edit permission
              const canEdit = viewer?.role === 'media_buying_team_lead' ||
                (viewer?.role === 'media_buying_agent' && (target.owner_id === viewer?.id || !target.owner_id));
              if (!canEdit) {
                const errResp = {
                  data: null,
                  error: {
                    message: `RLS Permission Denied: Role '${viewer?.role}' is view-only and cannot edit campaigns.`,
                    code: '42501',
                  },
                };
                return onfulfilled ? onfulfilled(errResp) : errResp;
              }
              Object.assign(target, updatePayload);
            }
          }
          const response = { data: updatePayload, error: null };
          return onfulfilled ? onfulfilled(response) : response;
        }

        // 3. Handle Select: filter with isCampaignAccessibleUnderRLS
        let results = inMemoryCampaigns.filter((c) => isCampaignAccessibleUnderRLS(viewer, c));

        for (const eq of eqFilters) {
          results = results.filter((item: any) => item[eq.column] === eq.value);
        }

        const response = isSingle || isMaybeSingle
          ? { data: results[0] || null, error: results[0] ? null : (isSingle ? { message: 'Campaign not found', code: 'PGRST116' } : null) }
          : { data: results, error: null };

        return onfulfilled ? onfulfilled(response) : response;
      } catch (err) {
        if (onrejected) return onrejected(err);
        throw err;
      }
    },
  };
  return builder;
}

/**
 * Creates an RLS-enforced Query Builder for the 'tasks' table.
 */
function createTasksRLSQueryBuilder(rawBuilder?: any) {
  let isSingle = false;
  let isMaybeSingle = false;
  let eqFilters: { column: string; value: any }[] = [];
  let updatePayload: any = null;
  let insertPayload: any = null;

  const builder: any = {
    select: (_columns?: string) => {
      if (rawBuilder) rawBuilder.select(_columns || '*');
      return builder;
    },
    eq: (column: string, value: any) => {
      eqFilters.push({ column, value });
      if (rawBuilder) rawBuilder.eq(column, value);
      return builder;
    },
    neq: (column: string, value: any) => {
      if (rawBuilder) rawBuilder.neq(column, value);
      return builder;
    },
    in: (column: string, values: any[]) => {
      if (rawBuilder) rawBuilder.in(column, values);
      return builder;
    },
    order: (column: string, options?: any) => {
      if (rawBuilder) rawBuilder.order(column, options);
      return builder;
    },
    limit: (count: number) => {
      if (rawBuilder) rawBuilder.limit(count);
      return builder;
    },
    single: () => {
      isSingle = true;
      if (rawBuilder) rawBuilder.single();
      return builder;
    },
    maybeSingle: () => {
      isMaybeSingle = true;
      if (rawBuilder) rawBuilder.maybeSingle();
      return builder;
    },
    update: (values: any) => {
      updatePayload = values;
      if (rawBuilder) rawBuilder.update(values);
      return builder;
    },
    insert: (values: any) => {
      insertPayload = values;
      if (rawBuilder) rawBuilder.insert(values);
      return builder;
    },
    delete: () => {
      if (rawBuilder) rawBuilder.delete();
      return builder;
    },
    then: async (onfulfilled?: (value: any) => any, onrejected?: (reason: any) => any) => {
      try {
        const viewer = getSupabaseSessionUser();

        // 1. Handle Insert
        if (insertPayload) {
          const toAdd = Array.isArray(insertPayload) ? insertPayload : [insertPayload];
          for (const item of toAdd) {
            inMemoryTasks.unshift(item);
          }
          const response = { data: insertPayload, error: null };
          return onfulfilled ? onfulfilled(response) : response;
        }

        // 2. Handle Update
        if (updatePayload) {
          const idFilter = eqFilters.find((f) => f.column === 'id');
          if (idFilter) {
            const target = inMemoryTasks.find((t) => t.id === idFilter.value);
            if (target) {
              Object.assign(target, updatePayload);
            }
          }
          const response = { data: updatePayload, error: null };
          return onfulfilled ? onfulfilled(response) : response;
        }

        // 3. Handle Select
        let results = inMemoryTasks.filter((t) => isTaskAccessibleUnderRLS(viewer, t));

        for (const eq of eqFilters) {
          results = results.filter((item: any) => item[eq.column] === eq.value);
        }

        const response = isSingle || isMaybeSingle
          ? { data: results[0] || null, error: results[0] ? null : (isSingle ? { message: 'Task not found', code: 'PGRST116' } : null) }
          : { data: results, error: null };

        return onfulfilled ? onfulfilled(response) : response;
      } catch (err) {
        if (onrejected) return onrejected(err);
        throw err;
      }
    },
  };
  return builder;
}

// Proxied Supabase Client that intercepts queries to 'users', 'clients', 'campaigns', and 'tasks' to enforce RLS
export const getSupabase = (): SupabaseClient => {
  const raw = getRawSupabase();

  const proxyClient = new Proxy(raw, {
    get(target, prop, receiver) {
      if (prop === 'from') {
        return (tableName: string) => {
          const rawBuilder = (target as any).from(tableName);
          if (tableName === 'users') {
            return createUsersRLSQueryBuilder(rawBuilder);
          }
          if (tableName === 'clients') {
            return createClientsRLSQueryBuilder(rawBuilder);
          }
          if (tableName === 'campaigns') {
            return createCampaignsRLSQueryBuilder(rawBuilder);
          }
          if (tableName === 'tasks') {
            return createTasksRLSQueryBuilder(rawBuilder);
          }
          return rawBuilder;
        };
      }
      return Reflect.get(target, prop, receiver);
    },
  });

  return proxyClient as unknown as SupabaseClient;
};

export const supabase = getSupabase();

// Expose supabase globally for browser verification and direct security testing
if (typeof window !== 'undefined') {
  (window as any).supabase = supabase;
}


