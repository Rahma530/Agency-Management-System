/**
 * Agency Management System - Database Schema Types
 * Matched strictly to existing Supabase tables (16 tables) and Row Level Security (RLS)
 */

export type UserRole =
  | 'executive'                 // Executive Management (C-level)
  | 'head_of_technical'         // Head of Technical
  | 'sales'                     // Sales Team (Sales)
  | 'am_team_lead'              // AM Team Leader
  | 'am_agent'                  // AM Agent
  | 'media_buying_team_lead'    // Media Buying Team Leader
  | 'media_buying_agent'        // Media Buying Agent
  | 'seo_team_lead'             // SEO Team Leader
  | 'seo_agent'                 // SEO Agent
  | 'seo_content_agent'         // SEO Content Specialist — identical treatment to seo_agent everywhere
  | 'seo_backlink_agent'        // SEO Backlink Specialist — identical treatment to seo_agent everywhere
  // No dedicated team lead of its own — folded under seo_team_lead's oversight, the same way
  // graphic_designer/video_editor have no dedicated lead, but exclusively owned by seo_team_lead
  // rather than shared across every team lead the way the creative pool is.
  | 'programming_agent'         // Programming Agent
  | 'social_media_team_lead'    // Social Media Team Leader
  | 'social_media_agent'        // Social Media Agent
  | 'graphic_designer'          // Graphic Designer
  | 'video_editor'              // Video Editor
  | 'ai_engineer'                // AI Engineer
  // NOT a team lead of graphic_designer/video_editor — that shared resource pool stays exactly
  // as-is (no dedicated manager, visible to everyone but sales via employee_visible()'s existing
  // branch). marketing_manager is a narrow, cross-cutting exception layered on top: visibility
  // into and task-assignment rights over ONLY graphic_designer/video_editor's tasks, plus
  // read-only capacity visibility for the same two roles. No employee-management rights
  // (edit/deactivate/role-change) anywhere.
  | 'marketing_manager';         // Marketing Manager

export type ServiceType = 'seo' | 'social_media' | 'media_buying' | 'creative';

// Module 13: 5-value lifecycle, replacing the old 4-value 'lead'|'onboarding'|'active'|'renewal'|
// 'churned' set. 'lead' is gone — a ClientRecord is now only ever created at 'onboarding' (that
// creation IS the Sales -> AM Team Lead handoff, no separate stage before it). 'churned' is
// renamed 'closed'. 'paused' is new: a temporary halt, can return to 'active'.
export type ClientStatus = 'onboarding' | 'active' | 'paused' | 'renewal' | 'closed';

export type TaskStatus = 'todo' | 'in_progress' | 'in_review' | 'completed' | 'blocked';
export type TaskPriority = 'low' | 'medium' | 'high' | 'urgent';

// 1. users
export interface UserRecord {
  id: string;
  name: string;
  email?: string;
  password?: string;
  role: UserRole;
  team?: string | null;
  manager_id?: string | null;
  capacity_limit?: number | null;
  // Null for a "pending" employee created via the Add Employee admin flow (single form or bulk
  // upload) — real Supabase Auth account creation needs the service-role key, which never touches
  // the browser, so it happens out-of-band via scripts/provisionAuthUsers.ts. Use
  // lib/permissions.ts's isPendingEmployee() rather than checking this directly everywhere.
  auth_id: string | null;
  // Null while active. Set the moment an executive/head_of_technical/team-lead deactivates this
  // employee — the row is never deleted (so their name still displays correctly on every
  // historical task/brief/daily-log/report they're referenced from), but they lose all
  // capability: excluded from every active-employee picker/list (lib/permissions.ts's
  // isActiveEmployee()), can never receive new assignments, and their auth.users account is
  // separately banned (~100 year ban_duration, reversible) by scripts/deactivateAuthUser.ts.
  deactivated_at?: string | null;
  created_at?: string;
}

// 3. clients
export interface ClientRecord {
  id: string;
  name: string;
  industry?: string | null;
  // Module 14: plain free-text contact number, no format enforcement (spans multiple countries/
  // formats). Optional at registration — collected via ClientRegistrationModal, searchable
  // alongside name via lib/clientSearch.ts's shared predicate.
  phone_number?: string | null;
  // Module 13 Phase 5: which services this client is directly subscribed to — SEO, Social Media,
  // Media Buying, Creative, any combination. Replaces the old named-Package indirection
  // (package_id -> packages.services); no "package" concept exists in this schema anymore.
  // Never empty in practice, but the type allows it since a brand-new client mid-registration may
  // transiently have none selected yet.
  services: ServiceType[];
  status: ClientStatus;
  sales_owner_id?: string | null;
  am_agent_id?: string | null;
  am_team_lead_id?: string | null;
  contract_value?: number | null;
  start_date?: string | null;
  renewal_date?: string | null;
  am_team_lead_viewed_at?: string | null;
  // Field names kept as-is (Module 13 only renamed the status VALUE 'churned' -> 'closed', not
  // these columns) — set automatically by handleUpdateClientStatus (App.tsx) the moment status
  // transitions to 'closed'. Null for any client that closed before this column existed — not
  // retroactively backfillable, since there's no reliable prior signal for when that happened.
  // Consumers doing period-scoped math must treat a null churned_at on a closed client as
  // "unknown date", not as "not closed" or "closed now".
  churn_reason?: string | null;
  churned_at?: string | null;
  // Dedicated, rotatable client-portal URL identifier — deliberately not the same as `id`, so a
  // leaked or rotated portal link never touches the client's actual primary key. Null until a
  // portal login is created for this client (ClientDashboard.tsx's "Create Portal Login" action).
  portal_slug?: string | null;
  // Module 12 Phase 7: AM Team Lead payment-tracking, distinct from contract_value (Sales's
  // monthly retainer figure, set once at registration). Tracks the actual payment schedule
  // against a signed contract's total value — manually editable, never auto-computed.
  due_value?: number | null;
  remaining_value?: number | null;
  contract_duration_months?: number | null;
  // Module 13 Phase 4: cleared to null whenever am_agent_id changes, set to now() when it's
  // assigned — mirrors the viewed_at-clearing convention from Module 12 Phase 5. Drives the
  // period-scoped gained/lost client metrics in MyWorkHub; not a general "assigned since" display
  // field beyond that.
  am_agent_assigned_at?: string | null;
  created_at?: string;
}

// 3b. client_portal_users — the client-portal analog of `users`: one row per external client
// login, parallel to (not merged with) the employee identity model. auth_id is null until the
// client claims the row via self-signup (see ClientPortalLogin.tsx) — this app has no
// service-role key to create another user's Supabase Auth account directly, so a login always
// starts as a staff-created placeholder.
export interface ClientPortalUserRecord {
  id: string;
  client_id: string;
  auth_id?: string | null;
  email: string;
  created_at?: string;
}

// 4. briefs
export interface BriefRecord {
  id: string;
  client_id: string;
  service_type: ServiceType;
  fields: Record<string, any>;
  submitted_by: string;
  version: number;
  // Cleared to null on every save; set when the relevant service Team Lead views this brief.
  // Shared per-role (no per-client "assigned service team lead" concept exists), unlike the
  // per-individual am_team_lead_viewed_at on ClientRecord.
  team_lead_viewed_at?: string | null;
  // One-off questions added to THIS client's brief only — never appear on any other client's
  // brief for this service, and never touch the global per-service question list in
  // brief_field_schemas. Rendered appended after that global list's fields. The answer to a
  // custom question lives in `fields` exactly like a built-in field's — only the question
  // definition itself lives here.
  custom_field_defs: BriefFieldDef[];
  created_at?: string;
  updated_at?: string;
}

// 4a2. brief_field_schemas — the GLOBAL, per-service-type brief question list. Source of truth
// moved here from the old static src/data/briefFieldSchemas.ts object so it can be edited from
// the app (BriefFieldSchemaEditor.tsx) instead of requiring a code change + redeploy. Editing a
// row here affects every NEW brief filled out for that service_type going forward; a brief
// already submitted keeps whatever it already has in `fields`, regardless of later schema edits.
export type BriefFieldType = 'text' | 'textarea' | 'url' | 'tag-list';

export interface BriefFieldDef {
  key: string;
  label: string;
  type: BriefFieldType;
  placeholder?: string;
  span?: 'full' | 'half';
  rows?: number;
  fallback?: string;
  valueClassName?: string;
  chipClassName?: string;
  required?: boolean;
}

// The actual DB row shape (snake_case columns, matching every other *Record type in this file) —
// kept distinct from the camelCase BriefFieldDef the renderer components consume. See
// lib/briefFieldSchemas.ts's toBriefFieldDef() for the row -> BriefFieldDef mapping.
export interface BriefFieldSchemaRow {
  id: string;
  service_type: ServiceType;
  key: string;
  label: string;
  type: BriefFieldType;
  placeholder?: string | null;
  span?: 'full' | 'half' | null;
  rows?: number | null;
  fallback?: string | null;
  value_class_name?: string | null;
  chip_class_name?: string | null;
  required: boolean;
  sort_order: number;
  created_at?: string;
  updated_at?: string;
}

// 4b. brief_revisions — append-only audit log; one full field snapshot per brief save
export interface BriefRevisionRecord {
  id: string;
  brief_id: string;
  client_id: string; // denormalized from the parent brief, for RLS scoping without a join
  service_type: ServiceType; // denormalized, same reason
  version: number; // matches briefs.version at the moment of this save
  fields: Record<string, any>;
  edited_by: string;
  edited_at: string;
}

// 5. assignments
export interface AssignmentRecord {
  id: string;
  client_id: string;
  service_type: ServiceType;
  team_lead_id: string;
  agent_id: string;
  assigned_at: string;
  reason_notes?: string | null;
  // Module 12 Phase 5: cleared to null whenever agent_id changes (a
  // reassignment is a fresh "new client" for the new agent), set when the
  // assigned agent opens the client. Drives a "New" notification badge —
  // never gates access, mirrors clients.am_team_lead_viewed_at.
  viewed_at?: string | null;
}

// 6. tasks
export interface TaskRecord {
  id: string;
  client_id: string;
  title: string;
  description: string;
  assigned_to?: string | null;
  created_by: string;
  team?: string | null;
  status: TaskStatus;
  due_date: string;
  priority: TaskPriority;
  estimated_hours?: number | null;
  actual_hours?: number | null;
  created_at?: string;
  // Self-reference for subtasks. Nesting is capped at 3 levels
  // (task -> subtask -> sub-subtask) by a DB trigger.
  parent_task_id?: string | null;
  // Set when status becomes 'completed', cleared otherwise (see
  // handleUpdateTaskStatus/handleUpdateTask in App.tsx). Needed to filter
  // "completed today" — status alone carries no timing information.
  completed_at?: string | null;
  // Module 12 Phase 5: notification-badge equivalent of assignments.viewed_at
  // for roles with no AssignmentRecord relationship (programming_agent).
  // Cleared to null whenever assigned_to changes, set when the assignee
  // opens the client this task belongs to.
  assignee_viewed_at?: string | null;
  // Module 12 Phase 9: manually-pasted Google Drive URL — no real Drive API integration,
  // same scaffolding-only posture as Module 6's other integration points.
  drive_link?: string | null;
}

// 6b. task_comments — threaded comments on a task, capped at 3 levels
// (comment -> reply -> reply-to-reply) by a DB trigger, same as tasks
// nesting. Soft-delete via deleted_at (never a real DELETE) so a deleted
// comment's replies stay attached to a real row instead of orphaning.
export interface TaskCommentRecord {
  id: string;
  task_id: string;
  parent_comment_id?: string | null;
  author_id: string;
  body: string;
  created_at: string;
  edited_at?: string | null;
  deleted_at?: string | null;
}

// 6c. task_attachments — files attached to a task. Bytes live in the private
// 'task-attachments' Storage bucket at storage_path; this row is just the
// metadata index. Hard-deleted (unlike comments — nothing references an
// attachment as a parent, so there's no orphaning concern).
export interface TaskAttachmentRecord {
  id: string;
  task_id: string;
  storage_path: string;
  filename: string;
  file_size: number;
  mime_type: string;
  uploaded_by: string;
  uploaded_at: string;
}

// 6c. client_contracts — Module 12 Phase 6, same shape as TaskAttachmentRecord, one level up
// (client instead of task) for Sales's signed-contract upload.
export interface ClientContractRecord {
  id: string;
  client_id: string;
  storage_path: string;
  filename: string;
  file_size: number;
  mime_type: string;
  uploaded_by: string;
  uploaded_at: string;
}

// 7. campaigns
export type CampaignStatus = 'draft' | 'active' | 'paused' | 'completed' | 'archived';

export interface CampaignRecord {
  id: string;
  client_id: string;
  name?: string;
  platform: 'meta' | 'google' | 'tiktok' | 'linkedin' | 'snapchat' | 'x' | string;
  objective?: string;
  status?: CampaignStatus;
  campaign_id_external?: string | null;
  spend: number;
  budget?: number | null;
  start_date?: string | null;
  end_date?: string | null;
  owner_id?: string | null;
  team?: string | null;
  results: Record<string, any>;
  date: string;
  created_at?: string;
}

// 8. social_insights
export interface SocialInsightRecord {
  id: string;
  client_id: string;
  platform: 'facebook' | 'instagram' | 'tiktok' | 'x' | 'linkedin' | string;
  metrics: Record<string, any>;
  date: string;
}

// Module 6 (External Integrations Hub) scaffolding — see
// supabase/migrations/20260915100000_platform_connections.sql. No
// credential/token field exists here on purpose; see that migration's
// header comment for where real credentials would eventually live.
export type PlatformCategory = 'media_buying' | 'analytics' | 'social_media';
export type PlatformConnectionStatus = 'not_connected' | 'pending' | 'connected';

export interface PlatformConnectionRecord {
  id: string;
  client_id: string;
  platform_category: PlatformCategory;
  platform_name: string;
  status: PlatformConnectionStatus;
  connected_by?: string | null;
  connected_at?: string | null;
  last_synced_at?: string | null;
  notes?: string | null;
  created_at?: string;
  updated_at?: string;
}

// Destination table for performance/analytics/traffic data (e.g. GA4,
// Search Console) — mirrors SocialInsightRecord exactly. Nothing writes to
// this yet; it exists so the data model is complete ahead of a real pull.
export interface AnalyticsInsightRecord {
  id: string;
  client_id: string;
  platform: 'google_analytics' | 'google_search_console' | string;
  metrics: Record<string, any>;
  date: string;
}

// 9. reports
export interface ReportRecord {
  id: string;
  // Null for an aggregate report (all-my-clients or a specific agent's clients) — those have no
  // single client. The report's actual subject (one client, or an agent's pooled clients) always
  // lives on the client_comparisons row it points to via comparison_id, which is the single
  // source of truth for scope; this column is a display convenience for the single-client case.
  client_id?: string | null;
  type: 'internal' | 'client';
  period: string;
  generated_by: string;
  file_url?: string | null;
  // Points at the client_comparisons row backing this report's analytical content — a monthly
  // report is, content-wise, a current-vs-previous-period comparison. Null only for reports
  // created before this link existed.
  comparison_id?: string | null;
  // 'final' for every report created before this column existed (see migration default) and for
  // the existing "Generate Report" flow, which is already a deliberate, reviewed action. 'draft'
  // is used only by the new auto-compiled monthly report draft (Module 9) — a richer document
  // (period summary + brief snapshot + task completion) that a human must explicitly approve
  // before it's treated as final.
  status?: 'draft' | 'final';
  approved_by?: string | null;
  approved_at?: string | null;
  created_at?: string;
}

// 10. capacity_logs
export interface CapacityLogRecord {
  id: string;
  agent_id: string;
  date: string;
  active_clients_count: number;
}

// 11. daily_logs
export interface DailyLogRecord {
  id: string;
  user_id: string;
  date: string;
  summary_text: string;
  linked_task_ids?: string[] | null;
  // Which client this entry's work relates to, if any — single nullable id, matching every other
  // work-artifact table in this schema (tasks/briefs/campaigns), not an array. A day genuinely
  // spanning multiple clients is already handled today by writing multiple log rows.
  client_id?: string | null;
  created_at?: string;
}

export interface KpiRecord {
  id: string;
  user_id?: string | null;
  team?: string | null;
  metric_name: string;
  target_value: number;
  current_value: number;
  period: string;
}

// 17. notifications
export interface NotificationRecord {
  id: string;
  user_id: string;
  title: string;
  message: string;
  // null = system-generated (no human sender to attribute it to) — see
  // notifications_insert_rls in the Phase 1 real-time migration.
  sender_id?: string | null;
  is_read: boolean;
  type: 'task_assigned' | 'task_updated' | 'task_overdue' | 'general';
  link_url?: string | null;
  created_at: string;
}

// 18. activities
export interface ActivityRecord {
  id: string;
  user_id: string; // The person who did the action
  action_type: 'create' | 'update' | 'delete' | 'complete' | 'status_change';
  target_type: 'task' | 'client' | 'campaign' | 'brief';
  target_id: string;
  target_name: string;
  details?: string | null;
  created_at: string;
}

// 19. chat_messages
export interface ChatMessageRecord {
  id: string;
  sender_id: string;
  receiver_id: string;
  content: string;
  is_read: boolean;
  created_at: string;
}

// Minimal org-wide employee directory for MiniChat's colleague list, from the
// chat_directory() RPC — deliberately NOT the RLS-scoped UserRecord shape:
// messaging is unrestricted by design (any employee can message any employee),
// while everything else that reads `users` stays scoped by employee_visible().
export interface ChatDirectoryEntry {
  id: string;
  name: string;
  role: UserRole;
}

// 12. extra_notes
export interface ExtraNoteRecord {
  id: string;
  user_id: string;
  date: string;
  note_text: string;
  category?: string | null;
  created_at?: string;
}

// 13. performance_reviews
export interface PerformanceReviewRecord {
  id: string;
  user_id: string;
  period: string;
  efficiency_score: number;
  strengths?: string | null;
  improvement_areas?: string | null;
  growth_recommendation?: string | null;
  reviewed_by: string;
  created_at?: string;
}

// 14. meetings
export interface MeetingRecord {
  id: string;
  client_id: string;
  am_agent_id: string;
  meeting_date: string;
  recording_url?: string | null;
  transcript_text?: string | null;
  ai_summary_text?: string | null;
  action_items?: Record<string, any> | Array<any> | null;
  created_at?: string;
}

// 15. kpi_scores
export type PerformancePeriodType = 'monthly' | 'quarterly';

// Shape of KpiScoreRecord.metrics (stored as JSONB — untyped at the DB
// layer, typed here for the app side). client_satisfaction and
// task_execution_quality stay null until a real data source exists for
// them (see src/lib/performanceScore.ts) — the overall score is computed
// only from the three indicators that do have real data, with weights
// renormalized across those three.
export interface KpiScoreMetrics {
  period_type: PerformancePeriodType;
  period_start: string;
  period_end: string;
  on_time_completion_rate: number | null; // 0-100, null = no completions in period
  capacity_utilization_score: number | null; // 0-100, null = untracked (capacity_limit 0)
  initiative_score: number | null; // 0-100, from extra_notes count
  client_satisfaction: null; // no data source yet
  task_execution_quality: null; // no data source yet
  weights: Record<'on_time_completion_rate' | 'capacity_utilization_score' | 'initiative_score', number>;
}

export interface KpiScoreRecord {
  id: string;
  user_id: string;
  period: string;
  metrics: KpiScoreMetrics;
  overall_score: number;
  suggested_status?: 'promotion' | 'raise' | 'development_plan' | 'stable' | string | null;
  reviewed_by?: string | null;
  created_at?: string;
}

// 16. client_comparisons
// Per-service-type indicator shapes for ClientComparisonRecord.metrics_current/metrics_previous
// (stored as JSONB — untyped at the DB layer, typed here for the app side). A client only
// carries the block(s) for the services in its package, so every block is optional. See
// src/lib/reportingEngine.ts for how each is aggregated.
export interface ComparisonMediaBuyingMetrics {
  spend: number;
  roas: number | null; // null when no campaigns had spend in the period (nothing to average)
  conversions: number;
  cpa: number | null; // null when conversions is 0 (undefined cost per acquisition)
}

// SEO has no analytics table in this schema (no keyword rankings, no organic traffic) — this is
// an operational delivery proxy from `tasks` where team === 'SEO', not a true performance metric.
export interface ComparisonSeoMetrics {
  completed_tasks: number;
  on_time_rate: number | null; // null when completed_tasks is 0
}

// social_insights.metrics is an untyped JSON blob per platform row with no guaranteed keys —
// every field here is defensively optional/nullable, pulled only when present in the source rows.
export interface ComparisonSocialMetrics {
  reach: number | null;
  engagement_rate: number | null;
  follower_growth: number | null;
}

export interface ClientComparisonMetrics {
  media_buying?: ComparisonMediaBuyingMetrics;
  seo?: ComparisonSeoMetrics;
  social_media?: ComparisonSocialMetrics;
}

// % change per indicator, current vs. previous period. null where either side is null/undefined
// (nothing meaningful to compare, e.g. no spend in either period).
export interface ClientComparisonDelta {
  media_buying?: Partial<Record<keyof ComparisonMediaBuyingMetrics, number | null>>;
  seo?: Partial<Record<keyof ComparisonSeoMetrics, number | null>>;
  social_media?: Partial<Record<keyof ComparisonSocialMetrics, number | null>>;
}

export interface ClientComparisonRecord {
  id: string;
  // Exactly one of client_id / agent_id is set (enforced by a DB check constraint):
  //  - client_id set, agent_id null: a single client's comparison (the original, unchanged shape).
  //  - agent_id set, client_id null: an aggregate pooled across an agent's resolved client set —
  //    either that agent's own "all my clients" report, or a team lead generating one for a
  //    specific direct report. See reportingEngine.ts's resolveClientsForSubject().
  client_id?: string | null;
  agent_id?: string | null;
  // Which clients actually got pooled into this row, recorded at generation time. Only set for
  // agent-scoped rows (client-scoped rows have exactly one client, already in client_id). Purely
  // for audit/drill-down display — RLS cannot re-verify this against current assignments (they
  // may have changed since generation), so it is not part of the access-control model.
  covered_client_ids?: string[] | null;
  // Explicit discriminant for which shape this row is, set directly at generation time (the
  // generator always knows which mode it's running) rather than inferred from period_previous:
  //  - 'comparison': the original shape — period_previous/metrics_previous/delta all populated.
  //  - 'period_summary': a single-period snapshot, no prior period to compare against —
  //    period_previous is null, metrics_previous/delta are {} (already valid: every field on
  //    those two types is optional), and ai_recommendations_text is null (no threshold rules run
  //    with nothing to compare).
  row_kind: 'comparison' | 'period_summary';
  period_current: string;
  // Null only for a 'period_summary' row.
  period_previous: string | null;
  metrics_current: ClientComparisonMetrics;
  metrics_previous: ClientComparisonMetrics;
  delta: ClientComparisonDelta;
  // Rule-generated summary + recommendation text (see reportingEngine.ts's threshold rules) —
  // deterministic, not a model call, despite the DB column's name.
  ai_recommendations_text?: string | null;
  created_at?: string;
}

export interface Database {
  public: {
    Tables: {
      users: { Row: UserRecord; Insert: Partial<UserRecord>; Update: Partial<UserRecord>; Relationships: any[] };
      clients: { Row: ClientRecord; Insert: Partial<ClientRecord>; Update: Partial<ClientRecord>; Relationships: any[] };
      briefs: { Row: BriefRecord; Insert: Partial<BriefRecord>; Update: Partial<BriefRecord>; Relationships: any[] };
      brief_revisions: { Row: BriefRevisionRecord; Insert: Partial<BriefRevisionRecord>; Update: Partial<BriefRevisionRecord>; Relationships: any[] };
      assignments: { Row: AssignmentRecord; Insert: Partial<AssignmentRecord>; Update: Partial<AssignmentRecord>; Relationships: any[] };
      tasks: { Row: TaskRecord; Insert: Partial<TaskRecord>; Update: Partial<TaskRecord>; Relationships: any[] };
      task_comments: { Row: TaskCommentRecord; Insert: Partial<TaskCommentRecord>; Update: Partial<TaskCommentRecord>; Relationships: any[] };
      task_attachments: { Row: TaskAttachmentRecord; Insert: Partial<TaskAttachmentRecord>; Update: Partial<TaskAttachmentRecord>; Relationships: any[] };
      campaigns: { Row: CampaignRecord; Insert: Partial<CampaignRecord>; Update: Partial<CampaignRecord>; Relationships: any[] };
      social_insights: { Row: SocialInsightRecord; Insert: Partial<SocialInsightRecord>; Update: Partial<SocialInsightRecord>; Relationships: any[] };
      reports: { Row: ReportRecord; Insert: Partial<ReportRecord>; Update: Partial<ReportRecord>; Relationships: any[] };
      capacity_logs: { Row: CapacityLogRecord; Insert: Partial<CapacityLogRecord>; Update: Partial<CapacityLogRecord>; Relationships: any[] };
      daily_logs: { Row: DailyLogRecord; Insert: Partial<DailyLogRecord>; Update: Partial<DailyLogRecord>; Relationships: any[] };
      extra_notes: { Row: ExtraNoteRecord; Insert: Partial<ExtraNoteRecord>; Update: Partial<ExtraNoteRecord>; Relationships: any[] };
      performance_reviews: { Row: PerformanceReviewRecord; Insert: Partial<PerformanceReviewRecord>; Update: Partial<PerformanceReviewRecord>; Relationships: any[] };
      meetings: { Row: MeetingRecord; Insert: Partial<MeetingRecord>; Update: Partial<MeetingRecord>; Relationships: any[] };
      kpi_scores: { Row: KpiScoreRecord; Insert: Partial<KpiScoreRecord>; Update: Partial<KpiScoreRecord>; Relationships: any[] };
      client_comparisons: { Row: ClientComparisonRecord; Insert: Partial<ClientComparisonRecord>; Update: Partial<ClientComparisonRecord>; Relationships: any[] };
    };
    Views: {
      [_ in never]: never;
    };
    Functions: {
      [_ in never]: never;
    };
    Enums: {
      [_ in never]: never;
    };
  };
}
