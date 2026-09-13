/**
 * Agency Management System - Database Schema Types
 * Matched strictly to existing Supabase tables (16 tables) and Row Level Security (RLS)
 */

export type UserRole =
  | 'executive'                 // Executive Management (C-level)
  | 'head_of_technical'         // Head of Technical
  | 'marketing_manager'         // Marketing Manager (cross-cutting Creative task/capacity oversight, not a team manager)
  | 'sales'                     // Sales Team (Sales)
  | 'am_team_lead'              // AM Team Leader
  | 'am_agent'                  // AM Agent
  | 'media_buying_team_lead'    // Media Buying Team Leader
  | 'media_buying_agent'        // Media Buying Agent
  | 'seo_team_lead'             // SEO Team Leader
  | 'seo_agent'                 // SEO Agent
  | 'social_media_team_lead'    // Social Media Team Leader
  | 'social_media_agent'        // Social Media Agent
  | 'graphic_designer'          // Graphic Designer
  | 'video_editor';             // Video Editor

export type ServiceType = 'seo' | 'social_media' | 'media_buying' | 'creative';

export type ClientStatus = 'lead' | 'onboarding' | 'active' | 'renewal' | 'churned';

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
  auth_id: string;
  created_at?: string;
}

// 2. packages
export interface PackageRecord {
  id: string;
  name: string;
  services: ServiceType[];
  created_at?: string;
}

// 3. clients
export interface ClientRecord {
  id: string;
  name: string;
  industry?: string | null;
  package_id?: string | null;
  status: ClientStatus;
  sales_owner_id?: string | null;
  am_agent_id?: string | null;
  am_team_lead_id?: string | null;
  contract_value?: number | null;
  start_date?: string | null;
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
  created_at?: string;
  updated_at?: string;
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
}

// 6. tasks
export interface TaskRecord {
  id: string;
  client_id: string;
  title: string;
  description?: string | null;
  assigned_to?: string | null;
  created_by: string;
  team?: string | null;
  status: TaskStatus;
  due_date?: string | null;
  priority: TaskPriority;
  estimated_hours?: number | null;
  actual_hours?: number | null;
  created_at?: string;
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

// 9. reports
export interface ReportRecord {
  id: string;
  client_id: string;
  type: 'internal' | 'client';
  period: string;
  generated_by: string;
  file_url?: string | null;
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
  sender_id: string;
  is_read: boolean;
  type: 'task_assigned' | 'task_updated' | 'task_overdue' | 'general';
  link_url?: string;
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
  details?: string;
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
export interface KpiScoreRecord {
  id: string;
  user_id: string;
  period: string;
  metrics: Record<string, any>;
  overall_score: number;
  suggested_status?: 'promotion' | 'raise' | 'development_plan' | 'stable' | string | null;
  reviewed_by?: string | null;
  created_at?: string;
}

// 16. client_comparisons
export interface ClientComparisonRecord {
  id: string;
  client_id: string;
  period_current: string;
  period_previous: string;
  metrics_current: Record<string, any>;
  metrics_previous: Record<string, any>;
  delta: Record<string, any>;
  ai_recommendations_text?: string | null;
  created_at?: string;
}

export interface Database {
  public: {
    Tables: {
      users: { Row: UserRecord; Insert: Partial<UserRecord>; Update: Partial<UserRecord>; Relationships: any[] };
      packages: { Row: PackageRecord; Insert: Partial<PackageRecord>; Update: Partial<PackageRecord>; Relationships: any[] };
      clients: { Row: ClientRecord; Insert: Partial<ClientRecord>; Update: Partial<ClientRecord>; Relationships: any[] };
      briefs: { Row: BriefRecord; Insert: Partial<BriefRecord>; Update: Partial<BriefRecord>; Relationships: any[] };
      assignments: { Row: AssignmentRecord; Insert: Partial<AssignmentRecord>; Update: Partial<AssignmentRecord>; Relationships: any[] };
      tasks: { Row: TaskRecord; Insert: Partial<TaskRecord>; Update: Partial<TaskRecord>; Relationships: any[] };
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
