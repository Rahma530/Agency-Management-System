import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import type { RealtimePostgresDeletePayload } from '@supabase/realtime-js';
import {
  Database,
  UserCheck,
  Layers,
  FileSpreadsheet,
  CheckCircle2,
  AlertCircle,
  Users,
  Building2,
  RefreshCw,
  Shield,
  ArrowLeftRight,
  Gauge,
  Kanban,
  FileText,
  Clock,
  LogOut,
  Target,
  BarChart3,
  Briefcase,
  UserPlus,
  Menu,
  X,
  Sun,
  Moon,
} from 'lucide-react';
import {
  supabase,
  supabaseRaw,
  isSupabaseConfigured,
  setSupabaseSessionUser,
  buildAttachmentStoragePath,
  buildMeetingRecordingStoragePath,
  buildClientContractStoragePath,
} from './lib/supabase';
import { canRegisterClient, canUseEmployeeTestingMode, canImpersonateEmployees, isActiveEmployee, canAccessClientOnboarding } from './lib/permissions';
import { isTeamLeadRole } from './lib/capacity';
import { isTaskDone } from './lib/taskLifecycle';
import { groupBriefFieldSchemas } from './data/briefFieldSchemas';
import { normalizeClientServices, SERVICE_LABELS } from './lib/clientServices';
import {
  ComparisonGranularity,
  ComparisonPeriod,
  DateRange,
  ReportMode,
  ReportScope,
  resolveComparisonPeriods,
  customPeriod,
  generateClientComparison,
  generatePeriodSummary,
  resolveClientsForSubject,
  serviceFilterForRole,
} from './lib/reportingEngine';
import { ReportsHub } from './components/ReportsHub';
import { EmployeeAdminHub, NewEmployeeInput } from './components/EmployeeAdminHub';
import { DashboardHub } from './components/DashboardHub';
import {
  ClientRecord,
  ClientSector,
  ClientStatus,
  UserRecord,
  BriefRecord,
  BriefRevisionRecord,
  TaskRecord,
  TaskCommentRecord,
  TaskAttachmentRecord,
  CapacityLogRecord,
  DailyLogRecord,
  ExtraNoteRecord,
  CampaignRecord,
  AssignmentRecord,
  ServiceType,
  UserRole,
  TaskStatus,
  TaskPriority,
  NotificationRecord,
  ActivityRecord,
  ChatMessageRecord,
  ChatConversationClearRecord,
  ChatDirectoryEntry,
  BriefFieldSchemaRow,
  SocialInsightRecord,
  ReportRecord,
  ClientComparisonRecord,
  ClientPortalUserRecord,
  MeetingRecord,
  ClientContractRecord,
  PlatformConnectionRecord,
  BriefFieldDef,
  PlatformCategory,
  PlatformConnectionStatus,
} from './types/database';
import {
  INITIAL_USERS,
  INITIAL_BRIEFS,
  INITIAL_CAPACITY_LOGS,
  INITIAL_DAILY_LOGS,
  INITIAL_EXTRA_NOTES,
  INITIAL_CAMPAIGNS,
  INITIAL_ASSIGNMENTS,
} from './data/initialData';
import {
  getRoleInfo,
  isModuleAllowed,
  getPortalSlug,
  AppModuleId,
} from './data/roles';
import { EmployeeLogin } from './components/EmployeeLogin';
import { EmployeeTestingMode, type GeneratedTestPassword, type TestAccountStatus } from './components/EmployeeTestingMode';
import { EmployeeImpersonation } from './components/EmployeeImpersonation';
import { SetPasswordScreen } from './components/SetPasswordScreen';
import { ClientRegistrationModal } from './components/ClientRegistrationModal';
import { BulkClientUploadModal } from './components/BulkClientUploadModal';
import { AMQueue } from './components/AMQueue';
import { CapacityManagement } from './components/CapacityManagement';
import { CrossTeamTaskBoard } from './components/CrossTeamTaskBoard';
import { DailyOperationsModule } from './components/DailyOperationsModule';
import { ImportDataModal } from './components/ImportDataModal';
import { CampaignManagementModule } from './components/CampaignManagementModule';
import { ServiceBriefsRoutingView } from './components/ServiceBriefsRoutingView';
import { MyWorkHub } from './components/MyWorkHub';
import { SalesPortalView } from './components/SalesPortalView';
import { AccessDenied } from './components/AccessDenied';
import { RolePortalHeader } from './components/RolePortalHeader';
import { OnlineUsersWidget } from './components/OnlineUsersWidget';
import { NotificationBell } from './components/NotificationBell';
import { GlobalSearch } from './components/GlobalSearch';
import { LiveActivityFeed } from './components/LiveActivityFeed';
import { MiniChat } from './components/MiniChat';
import { AIAssistantWidget } from './components/AIAssistantWidget';

export type AppModule = AppModuleId;

// DISABLED — superseded by the Impersonation tool below (EMPLOYEE_IMPERSONATION_ENABLED), which
// covers the same "access an employee's account without knowing their password" need without
// ever touching the employee's real password. Testing Mode's "Set Up Test Account" action
// generates and overwrites a real Supabase Auth password — a genuine risk of breaking an
// employee's actual login now that real per-employee passwords are being distributed
// (scripts/provisionAuthUsers.ts). Hardcoded off rather than left keyed to DEV/an env var, so no
// build mode can make this reachable again by accident. Kept unreachable, not deleted: this flag,
// the UI trigger below, EmployeeTestingMode.tsx, the employee-test-account Edge Function, and its
// migration history are all still in the repo for a dedicated future removal task, not this one.
const EMPLOYEE_TESTING_MODE_ENABLED = false;
const TEST_SESSION_KEY = 'agency_employee_test_handoff';
type TestHandoff = { employeeId: string; authId: string; email: string };

function readTestHandoff(): TestHandoff | null {
  try {
    const parsed = JSON.parse(sessionStorage.getItem(TEST_SESSION_KEY) || 'null');
    return parsed && typeof parsed.employeeId === 'string' && typeof parsed.authId === 'string'
      && typeof parsed.email === 'string' ? parsed as TestHandoff : null;
  } catch { return null; }
}

// TEMPORARY TRANSITION FEATURE — intended for removal once every employee has adopted their own
// real, self-set password. See supabase/functions/employee-impersonation/index.ts and
// src/components/EmployeeImpersonation.tsx for the full picture; this is just this file's slice
// of the same bridge tool, kept as isolated from the rest of App.tsx as Testing Mode's own
// handoff below, for the same reason: easy to delete outright later, not entangled with anything
// else.
const EMPLOYEE_IMPERSONATION_ENABLED = import.meta.env.DEV || import.meta.env.VITE_ENABLE_EMPLOYEE_IMPERSONATION === 'true';
const IMPERSONATION_SESSION_KEY = 'agency_employee_impersonation_handoff';
type ImpersonationHandoff = { employeeId: string; authId: string; email: string; sessionId: string };

function readImpersonationHandoff(): ImpersonationHandoff | null {
  try {
    const parsed = JSON.parse(sessionStorage.getItem(IMPERSONATION_SESSION_KEY) || 'null');
    return parsed && typeof parsed.employeeId === 'string' && typeof parsed.authId === 'string'
      && typeof parsed.email === 'string' && typeof parsed.sessionId === 'string' ? parsed as ImpersonationHandoff : null;
  } catch { return null; }
}

export default function App() {
  const [supabaseActive, setSupabaseActive] = useState(false);
  const [loading, setLoading] = useState(true);

  // Active module tab
  const [activeTab, setActiveTab] = useState<AppModule>('onboarding');
  const [unauthorizedRoute, setUnauthorizedRoute] = useState<string | null>(null);
  // Off-canvas sidebar drawer, mobile only (md breakpoint and below)
  const [isMobileSidebarOpen, setIsMobileSidebarOpen] = useState(false);

  // Light/dark theme — lazy-initialized from the <html data-theme> attribute the inline script
  // in index.html already set synchronously before this component ever mounts, so this never
  // causes its own flash; it's just mirroring what's already on the DOM into React state for
  // the toggle button's icon.
  const [theme, setTheme] = useState<'dark' | 'light'>(
    () => (document.documentElement.getAttribute('data-theme') === 'light' ? 'light' : 'dark')
  );
  const toggleTheme = () => {
    const next = theme === 'light' ? 'dark' : 'light';
    setTheme(next);
    if (next === 'light') {
      document.documentElement.setAttribute('data-theme', 'light');
    } else {
      document.documentElement.removeAttribute('data-theme');
    }
    try {
      localStorage.setItem('agency_theme', next);
    } catch {
      // localStorage unavailable — theme still applies for this session, just won't persist.
    }
  };

  // Online Users Mock State
  const [onlineUserIds, setOnlineUserIds] = useState<string[]>([]);

  // Data State
  const [users, setUsers] = useState<UserRecord[]>(INITIAL_USERS);
  const [usersLoadedFromSupabase, setUsersLoadedFromSupabase] = useState(false);
  const [clients, setClients] = useState<ClientRecord[]>([]);
  const [briefs, setBriefs] = useState<BriefRecord[]>(INITIAL_BRIEFS);
  const [briefRevisions, setBriefRevisions] = useState<BriefRevisionRecord[]>([]);
  // Global per-service brief question list — moved here from a static import (data/briefFieldSchemas.ts)
  // so it can be edited from the app. briefFieldSchemas below is the grouped Record<ServiceType,
  // BriefFieldDef[]> shape every render call site needs; briefFieldSchemaRows is the raw rows (with
  // id) the schema editor needs for update/delete.
  const [briefFieldSchemaRows, setBriefFieldSchemaRows] = useState<BriefFieldSchemaRow[]>([]);
  const briefFieldSchemas = useMemo(() => groupBriefFieldSchemas(briefFieldSchemaRows), [briefFieldSchemaRows]);
  const [tasks, setTasks] = useState<TaskRecord[]>([]);
  const [taskComments, setTaskComments] = useState<TaskCommentRecord[]>([]);
  const [taskAttachments, setTaskAttachments] = useState<TaskAttachmentRecord[]>([]);
  const [capacityLogs, setCapacityLogs] = useState<CapacityLogRecord[]>(INITIAL_CAPACITY_LOGS);
  const [dailyLogs, setDailyLogs] = useState<DailyLogRecord[]>(INITIAL_DAILY_LOGS);
  const [extraNotes, setExtraNotes] = useState<ExtraNoteRecord[]>(INITIAL_EXTRA_NOTES);
  const [campaigns, setCampaigns] = useState<CampaignRecord[]>(INITIAL_CAMPAIGNS);
  const [assignments, setAssignments] = useState<AssignmentRecord[]>(INITIAL_ASSIGNMENTS);
  const [socialInsights, setSocialInsights] = useState<SocialInsightRecord[]>([]);
  const [reports, setReports] = useState<ReportRecord[]>([]);
  const [clientComparisons, setClientComparisons] = useState<ClientComparisonRecord[]>([]);
  const [clientPortalUsers, setClientPortalUsers] = useState<ClientPortalUserRecord[]>([]);
  const [meetings, setMeetings] = useState<MeetingRecord[]>([]);
  const [clientContracts, setClientContracts] = useState<ClientContractRecord[]>([]);
  const [platformConnections, setPlatformConnections] = useState<PlatformConnectionRecord[]>([]);
  const [taskBoardAssigneePrefill, setTaskBoardAssigneePrefill] = useState<string | null>(null);
  const [notifications, setNotifications] = useState<NotificationRecord[]>([
    {
      id: 'notif-1',
      user_id: 'user-7', // طارق (Head of Tech)
      title: 'مهمة جديدة',
      message: 'تم تعيين مهمة لك: تحسين أداء الموقع - من قبل سلطان الشامسي',
      sender_id: 'user-1', // سلطان (Executive)
      is_read: false,
      type: 'task_assigned',
      created_at: new Date().toISOString(),
    },
    {
      id: 'notif-2',
      user_id: 'user-1', // سلطان
      title: 'مهمة مكتملة',
      message: 'قام طارق عبد الرحيم بإنهاء مهمة: إعداد سيرفرات الاستضافة',
      sender_id: 'user-7',
      is_read: false,
      type: 'task_updated',
      created_at: new Date(Date.now() - 3600000).toISOString(),
    },
    {
      id: 'notif-3',
      user_id: 'user-1', // سلطان (Executive)
      title: 'مهمة متأخرة ⚠️',
      message: 'تأخر كريم المنصور في تسليم مهمة: إعداد تقرير مبيعات الربع الأول',
      sender_id: 'user-3', // كريم
      is_read: false,
      type: 'task_overdue',
      created_at: new Date(Date.now() - 86400000).toISOString(),
    }
  ]);
  const [activities, setActivities] = useState<ActivityRecord[]>([
    {
      id: 'act-1',
      user_id: 'user-7',
      action_type: 'complete',
      target_type: 'task',
      target_id: 'task-1',
      target_name: 'إعداد سيرفرات الاستضافة',
      created_at: new Date(Date.now() - 3600000).toISOString(),
    },
    {
      id: 'act-2',
      user_id: 'user-2',
      action_type: 'create',
      target_type: 'client',
      target_id: 'client-new',
      target_name: 'شركة الأفق للتجارة',
      created_at: new Date().toISOString(),
    }
  ]);
  const [chatMessages, setChatMessages] = useState<ChatMessageRecord[]>([]);
  const [chatConversationClears, setChatConversationClears] = useState<ChatConversationClearRecord[]>([]);
  // Org-wide, id/name/role-only employee directory for MiniChat — deliberately NOT the
  // employee_visible()-scoped `users` array. See chat_directory() RPC: messaging has no
  // role/team restriction by design, unlike every other consumer of `users`.
  const [chatDirectory, setChatDirectory] = useState<ChatDirectoryEntry[]>([]);
  // Set when a notification's link_url ('chat:<senderId>') is clicked — a fresh object each
  // time (not just the userId string) so MiniChat's effect refires even for a second click on
  // a notification from the same sender, since a plain string dependency wouldn't change.
  const [chatOpenRequest, setChatOpenRequest] = useState<{ userId: string } | null>(null);
  const [isActivityFeedOpen, setIsActivityFeedOpen] = useState(false);
  // A Postgres UPDATE can reach this client before the corresponding INSERT/fetch payload.
  // Keep the local acknowledgement separate from the rendered list so a stale unread payload
  // cannot resurrect a notification the user has already cleared.
  const locallyReadNotificationIds = useRef(new Set<string>());

  // Import Data State
  const [isImportModalOpen, setIsImportModalOpen] = useState(false);
  const [importType, setImportType] = useState<'users' | 'clients'>('users');

  // Authenticated user state initialized from localStorage
  const [authenticatedUser, setAuthenticatedUser] = useState<UserRecord | null>(() => {
    if (isSupabaseConfigured()) return null;
    try {
      const savedUserId = localStorage.getItem('agency_auth_user_id');
      if (savedUserId) {
        const found = INITIAL_USERS.find((u) => u.id === savedUserId);
        if (found) return found;
      }
    } catch {
      // localStorage may fail in sandboxed contexts
    }
    return null;
  });

  // True while the current session is a Supabase PASSWORD_RECOVERY session
  // (a provisioning or password-reset link was just clicked) — gates
  // rendering to SetPasswordScreen instead of logging straight into the
  // app on a session that has no durable password behind it yet.
  const [isPasswordRecovery, setIsPasswordRecovery] = useState(false);

  const [isRegisterModalOpen, setIsRegisterModalOpen] = useState(false);
  const [isBulkClientUploadOpen, setIsBulkClientUploadOpen] = useState(false);
  const [verifiedTesterId, setVerifiedTesterId] = useState<string | null>(null);
  const [isTestingSelectorOpen, setIsTestingSelectorOpen] = useState(false);
  // Non-secret UI marker only. Auth and RLS always come from Supabase's actual session.
  const [testHandoff, setTestHandoff] = useState<TestHandoff | null>(readTestHandoff);
  const [verifiedTestAuthId, setVerifiedTestAuthId] = useState<string | null>(null);
  const [notification, setNotification] = useState<{ text: string; type: 'success' | 'info' } | null>(null);

  // TEMPORARY TRANSITION FEATURE — see the constants above and EmployeeImpersonation.tsx.
  const [verifiedImpersonatorId, setVerifiedImpersonatorId] = useState<string | null>(null);
  const [isImpersonationSelectorOpen, setIsImpersonationSelectorOpen] = useState(false);
  // Non-secret UI marker only, same as testHandoff above. Auth and RLS always come from
  // Supabase's actual session.
  const [impersonationHandoff, setImpersonationHandoff] = useState<ImpersonationHandoff | null>(readImpersonationHandoff);
  const [verifiedImpersonationAuthId, setVerifiedImpersonationAuthId] = useState<string | null>(null);

  // Current active user based on authenticated session
  const canAccessTestingMode = EMPLOYEE_TESTING_MODE_ENABLED && !testHandoff && !impersonationHandoff && !!authenticatedUser
    && verifiedTesterId === authenticatedUser.id && canUseEmployeeTestingMode(authenticatedUser.role);
  const canAccessImpersonation = EMPLOYEE_IMPERSONATION_ENABLED && !testHandoff && !impersonationHandoff && !!authenticatedUser
    && verifiedImpersonatorId === authenticatedUser.id && canImpersonateEmployees(authenticatedUser.role);
  const currentUser: UserRecord = authenticatedUser || (users && users.length > 0 ? users[0] : INITIAL_USERS[0]);
  const isRealTestSession = !!testHandoff && !!authenticatedUser
    && verifiedTestAuthId === testHandoff.authId && authenticatedUser.auth_id === testHandoff.authId
    && authenticatedUser.id === testHandoff.employeeId;
  const isRealImpersonationSession = !!impersonationHandoff && !!authenticatedUser
    && verifiedImpersonationAuthId === impersonationHandoff.authId && authenticatedUser.auth_id === impersonationHandoff.authId
    && authenticatedUser.id === impersonationHandoff.employeeId;
  const canRegisterClients = canRegisterClient(currentUser.role);
  const userRoleInfo = getRoleInfo(currentUser?.role || 'sales');

  const showNotification = (text: string, type: 'success' | 'info' = 'success') => {
    setNotification({ text, type });
    setTimeout(() => setNotification(null), 4500);
  };

  const mergeNotificationsPreservingLocalReads = (
    previous: NotificationRecord[],
    incoming: NotificationRecord[]
  ): NotificationRecord[] => {
    const previousById = new Map(previous.map((notification) => [notification.id, notification]));
    const incomingIds = new Set(incoming.map((notification) => notification.id));
    return [
      ...incoming.map((notification) => {
        const existing = previousById.get(notification.id);
        return !notification.is_read && (existing?.is_read || locallyReadNotificationIds.current.has(notification.id))
          ? { ...notification, is_read: true }
          : notification;
      }),
      ...previous.filter((notification) => !incomingIds.has(notification.id)),
    ];
  };

  // Optimistic-first: update local state immediately, then fire the Postgres write in the
  // background (error logged, not gated on). is_read is low-stakes and self-healing (worst
  // case, a brief UI/DB mismatch corrected on the next fetch/poll) — unlike chat send, where
  // persist-then-sync matters because showing an unsent message would be actively misleading.
  // This also sidesteps a real-world bug: a benign non-null `error` from a bare
  // update()-with-no-select() response was silently returning before setNotifications ran,
  // even though the write itself had already committed — the badge never cleared for the rest
  // of that session despite the database being correct (confirmed by a fresh login showing the
  // right read state all along).
  const handleMarkNotificationAsRead = (id: string) => {
    locallyReadNotificationIds.current.add(id);
    setNotifications(prev => prev.map(n => n.id === id ? { ...n, is_read: true } : n));
    if (supabaseActive) {
      supabaseRaw
        .from('notifications')
        .update({ is_read: true })
        .eq('id', id)
        .then(({ error }) => {
          if (error) console.error('Failed to persist notification read status:', error);
        });
    }
  };

  const handleMarkAllNotificationsAsRead = () => {
    setNotifications(prev => {
      prev.forEach((notification) => locallyReadNotificationIds.current.add(notification.id));
      return prev.map(n => ({ ...n, is_read: true }));
    });
    if (supabaseActive) {
      supabaseRaw
        .from('notifications')
        .update({ is_read: true })
        .eq('user_id', currentUser.id)
        .eq('is_read', false)
        .then(({ error }) => {
          if (error) console.error('Failed to persist all-notifications read status:', error);
        });
    }
  };

  // Notification click-through: link_url uses a 'chat:<senderId>' scheme (set by the
  // notify_new_chat_message() trigger) — parse it and hand the target user id to MiniChat via
  // chatOpenRequest. Any other/missing link_url is a no-op for now (only chat notifications
  // link anywhere today).
  const handleNotificationClick = (notification: NotificationRecord) => {
    if (notification.link_url?.startsWith('chat:')) {
      const otherUserId = notification.link_url.slice('chat:'.length);
      if (otherUserId) {
        const conversationLink = `chat:${otherUserId}`;
        setNotifications((prev) => {
          prev.forEach((item) => {
            if (item.user_id === currentUser.id && !item.is_read && item.link_url === conversationLink) {
              locallyReadNotificationIds.current.add(item.id);
            }
          });
          return prev.map((item) =>
            item.user_id === currentUser.id && !item.is_read && item.link_url === conversationLink
              ? { ...item, is_read: true }
              : item
          );
        });
        if (supabaseActive) {
          supabaseRaw
            .from('notifications')
            .update({ is_read: true })
            .eq('user_id', currentUser.id)
            .eq('is_read', false)
            .eq('link_url', conversationLink)
            .then(({ error }) => {
              if (error) console.error('Failed to persist chat notification read status:', error);
            });
        }
        setChatOpenRequest({ userId: otherUserId });
      }
    }
  };

  // Kept in sync below so the session-rehydration effect can read the latest
  // `users` without depending on it directly — that dependency previously
  // made the whole effect (including tearing down and re-subscribing the
  // auth listener) re-run on every users fetch, which is what caused the
  // repeated reload loop: each re-subscribe re-ran restoreSession(), which
  // set a freshly-fetched authenticatedUser object, whose new reference fed
  // straight back into loadData's own dependency, triggering another users
  // fetch, and so on indefinitely.
  const usersRef = useRef(users);
  useEffect(() => {
    usersRef.current = users;
  }, [users]);

  // 1. Session Rehydration from Supabase on mount
  useEffect(() => {
    // A provisioning/password-reset link lands back here with a recovery
    // marker in the URL before supabase-js has parsed it into a session.
    // restoreSession()'s plain getSession() call below can't distinguish a
    // recovery session from a normal one, so it must not auto-login here —
    // isPasswordRecovery is set synchronously from this check right below,
    // rather than waiting on the onAuthStateChange listener's PASSWORD_RECOVERY
    // event, since that's a one-shot event that can be lost if the listener
    // isn't attached yet when it fires (e.g. React StrictMode's mount ->
    // cleanup -> re-mount cycle tearing down the very listener that would
    // have caught it). The event-based branch below stays as a secondary,
    // defensive path only.
    const isRecoveryRedirect =
      window.location.hash.includes('type=recovery') || window.location.search.includes('type=recovery');

    if (isRecoveryRedirect) {
      setIsPasswordRecovery(true);
    }

    const restoreSession = async () => {
      if (isRecoveryRedirect) return;

      if (isSupabaseConfigured()) {
        try {
          const { data: { session } } = await supabase.auth.getSession();
          if (session?.user) {
            // supabaseRaw bypasses the legacy client-side users proxy — that proxy's .or()
            // lookup only matches the hardcoded demo seed array, never a real Postgres row.
            const { data: dbUser } = await supabaseRaw
              .from('users')
              .select('*')
              .eq('auth_id', session.user.id)
              .single();
            if (dbUser && !dbUser.deactivated_at) {
              setAuthenticatedUser(dbUser as UserRecord);
              return;
            }
          }
        } catch (err) {
          console.warn('Session check warning:', err);
        }
        // A cached employee ID cannot replace a real Supabase Auth session.
        setAuthenticatedUser(null);
        return;
      }

      // Check localStorage cached user
      try {
        const savedUserId = localStorage.getItem('agency_auth_user_id');
        if (savedUserId) {
          const matched = usersRef.current.find((u) => u.id === savedUserId);
          if (matched) {
            setAuthenticatedUser(matched);
            return;
          }
        }
      } catch {}
    };

    restoreSession();

    if (isSupabaseConfigured()) {
      const { data: authListener } = supabase.auth.onAuthStateChange(async (event, session) => {
        if (event === 'PASSWORD_RECOVERY') {
          setIsPasswordRecovery(true);
          return;
        }
        if (session?.user) {
          // supabaseRaw bypasses the legacy client-side users proxy — that proxy's .or()
          // lookup only matches the hardcoded demo seed array, never a real Postgres row.
          const { data: dbUser } = await supabaseRaw
            .from('users')
            .select('*')
            .eq('auth_id', session.user.id)
            .single();
          if (dbUser && !dbUser.deactivated_at) {
            setAuthenticatedUser(dbUser as UserRecord);
          } else {
            setAuthenticatedUser(null);
          }
        } else if (event === 'SIGNED_OUT') {
          setAuthenticatedUser(null);
        }
      });
      return () => {
        authListener?.subscription?.unsubscribe();
      };
    }
  }, []);

  // Validate the real Supabase JWT and the linked public.users row before
  // exposing the temporary selector. Cached/demo employee state is insufficient.
  useEffect(() => {
    let cancelled = false;
    setVerifiedTesterId(null);
    setIsTestingSelectorOpen(false);
    if (!EMPLOYEE_TESTING_MODE_ENABLED || !authenticatedUser || !isSupabaseConfigured()
      || !canUseEmployeeTestingMode(authenticatedUser.role)) {
      return;
    }
    (async () => {
      const { data: { user }, error: authError } = await supabaseRaw.auth.getUser();
      if (cancelled || authError || !user) return;
      const { data: admin, error } = await supabaseRaw.from('users')
        .select('id, role, auth_id, deactivated_at')
        .eq('auth_id', user.id)
        .maybeSingle();
      if (!cancelled && !error && admin && admin.id === authenticatedUser.id
        && admin.role === authenticatedUser.role
        && !admin.deactivated_at && canUseEmployeeTestingMode(admin.role as UserRole)) {
        setVerifiedTesterId(admin.id);
      }
    })().catch((err) => console.warn('Testing Mode authorization check failed:', err));
    return () => { cancelled = true; };
  }, [authenticatedUser?.id, authenticatedUser?.role]);

  useEffect(() => {
    setVerifiedTestAuthId(null);
    if (!testHandoff || !authenticatedUser) return;
    let cancelled = false;
    supabaseRaw.auth.getUser().then(async ({ data: { user }, error }) => {
      if (cancelled) return;
      if (!error && user?.id === testHandoff.authId
        && authenticatedUser.auth_id === user.id && authenticatedUser.id === testHandoff.employeeId) {
        // app_user_id() resolves public.users through the server's auth.uid().
        const { data: rlsEmployeeId, error: rlsError } = await supabaseRaw.rpc('app_user_id');
        if (!cancelled && !rlsError && rlsEmployeeId === authenticatedUser.id) {
          setVerifiedTestAuthId(user.id);
        } else if (!cancelled) {
          setVerifiedTestAuthId(null);
        }
      } else {
        sessionStorage.removeItem(TEST_SESSION_KEY);
        setTestHandoff(null);
      }
    }).catch(() => {
      if (!cancelled) setVerifiedTestAuthId(null);
    });
    return () => { cancelled = true; };
  }, [testHandoff, authenticatedUser?.id, authenticatedUser?.auth_id]);

  // TEMPORARY TRANSITION FEATURE — validates the real Supabase JWT and the linked public.users
  // row before exposing the impersonation selector, same reasoning as the Testing Mode effect
  // above: cached/demo employee state is insufficient.
  useEffect(() => {
    let cancelled = false;
    setVerifiedImpersonatorId(null);
    setIsImpersonationSelectorOpen(false);
    if (!EMPLOYEE_IMPERSONATION_ENABLED || !authenticatedUser || !isSupabaseConfigured()
      || !canImpersonateEmployees(authenticatedUser.role)) {
      return;
    }
    (async () => {
      const { data: { user }, error: authError } = await supabaseRaw.auth.getUser();
      if (cancelled || authError || !user) return;
      const { data: admin, error } = await supabaseRaw.from('users')
        .select('id, role, auth_id, deactivated_at')
        .eq('auth_id', user.id)
        .maybeSingle();
      if (!cancelled && !error && admin && admin.id === authenticatedUser.id
        && admin.role === authenticatedUser.role
        && !admin.deactivated_at && canImpersonateEmployees(admin.role as UserRole)) {
        setVerifiedImpersonatorId(admin.id);
      }
    })().catch((err) => console.warn('Impersonation authorization check failed:', err));
    return () => { cancelled = true; };
  }, [authenticatedUser?.id, authenticatedUser?.role]);

  // TEMPORARY TRANSITION FEATURE — confirms a restored impersonationHandoff (e.g. after a page
  // refresh) still matches a real, live employee Auth session and RLS identity, same reasoning as
  // the Testing Mode effect above. A stale or tampered sessionStorage marker with no matching
  // session is cleared rather than trusted.
  useEffect(() => {
    setVerifiedImpersonationAuthId(null);
    if (!impersonationHandoff || !authenticatedUser) return;
    let cancelled = false;
    supabaseRaw.auth.getUser().then(async ({ data: { user }, error }) => {
      if (cancelled) return;
      if (!error && user?.id === impersonationHandoff.authId
        && authenticatedUser.auth_id === user.id && authenticatedUser.id === impersonationHandoff.employeeId) {
        const { data: rlsEmployeeId, error: rlsError } = await supabaseRaw.rpc('app_user_id');
        if (!cancelled && !rlsError && rlsEmployeeId === authenticatedUser.id) {
          setVerifiedImpersonationAuthId(user.id);
        } else if (!cancelled) {
          setVerifiedImpersonationAuthId(null);
        }
      } else {
        sessionStorage.removeItem(IMPERSONATION_SESSION_KEY);
        setImpersonationHandoff(null);
      }
    }).catch(() => {
      if (!cancelled) setVerifiedImpersonationAuthId(null);
    });
    return () => { cancelled = true; };
  }, [impersonationHandoff, authenticatedUser?.id, authenticatedUser?.auth_id]);

  // 2. Hash routing & unauthorized route protection
  useEffect(() => {
    if (!authenticatedUser) return;

    const handleHash = () => {
      const hash = window.location.hash.replace(/^#\/?/, '').trim();
      if (!hash || hash === 'login') {
        const roleMeta = getRoleInfo(authenticatedUser.role);
        setActiveTab(roleMeta.defaultModule);
        window.location.hash = `#/portal/${roleMeta.portalSlug}/${roleMeta.defaultModule}`;
        setUnauthorizedRoute(null);
        return;
      }

      const parts = hash.split('/');
      // Format: portal/:slug or portal/:slug/:module
      if (parts[0] === 'portal') {
        const requestedSlug = parts[1];
        const requestedModule = parts[2] as AppModuleId | undefined;
        const mySlug = getPortalSlug(authenticatedUser.role);

        // Disallow navigating to another employee's portal
        if (requestedSlug && requestedSlug !== mySlug) {
          setUnauthorizedRoute(`#/portal/${requestedSlug}`);
          return;
        }

        if (requestedModule) {
          if (!isModuleAllowed(authenticatedUser.role, requestedModule)) {
            setUnauthorizedRoute(`#/portal/${requestedSlug}/${requestedModule}`);
            return;
          }
          setActiveTab(requestedModule);
        } else {
          const meta = getRoleInfo(authenticatedUser.role);
          setActiveTab(meta.defaultModule);
        }
        setUnauthorizedRoute(null);
        return;
      }

      // Direct module hash format e.g. #onboarding or #capacity
      const validModules: AppModuleId[] = ['onboarding', 'service_briefs', 'capacity', 'tasks', 'daily_operations', 'campaigns'];
      if (validModules.includes(parts[0] as AppModuleId)) {
        const mod = parts[0] as AppModuleId;
        if (!isModuleAllowed(authenticatedUser.role, mod)) {
          setUnauthorizedRoute(`#/${mod}`);
          return;
        }
        setActiveTab(mod);
        setUnauthorizedRoute(null);
        return;
      }
    };

    window.addEventListener('hashchange', handleHash);
    handleHash();

    return () => window.removeEventListener('hashchange', handleHash);
    // authenticatedUser?.id — re-subscribing on every reference change (e.g. a same-person
    // SIGNED_IN re-notification on tab refocus) just re-ran handleHash() with the same hash,
    // producing a same-value setActiveTab no-op. Re-subscribing on an actual login/logout/
    // user-switch is enough; a role change for an already-logged-in user is picked up the next
    // time they navigate to a new hash anyway.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [authenticatedUser?.id]);

  // Switch tab and keep URL hash synchronized
  const handleTabChange = (newTab: AppModule, prefillAssigneeName?: string) => {
    if (!authenticatedUser) return;
    if (!isModuleAllowed(authenticatedUser.role, newTab)) {
      setUnauthorizedRoute(`#/${newTab}`);
      return;
    }
    setActiveTab(newTab);
    setUnauthorizedRoute(null);
    // Clears any stale prefill from a previous Capacity-button visit on a
    // plain nav-bar click (no second argument), not just when setting a new one.
    setTaskBoardAssigneePrefill(prefillAssigneeName ?? null);
    const mySlug = getPortalSlug(authenticatedUser.role);
    window.location.hash = `#/portal/${mySlug}/${newTab}`;
    setActiveTab(newTab);
    setIsMobileSidebarOpen(false);
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  const handleNavigateToModule = handleTabChange;

  const handleNavigateToHomePortal = () => {
    if (!authenticatedUser) return;
    setUnauthorizedRoute(null);
    const meta = getRoleInfo(authenticatedUser.role);
    setActiveTab(meta.defaultModule);
    window.location.hash = `#/portal/${meta.portalSlug}/${meta.defaultModule}`;
  };

  const invokeTestAccount = async (action: 'status' | 'setup' | 'generate_test_password', employeeId: string, password?: string): Promise<TestAccountStatus & { temporaryPassword?: string }> => {
    if (!canAccessTestingMode || !usersLoadedFromSupabase) {
      throw new Error('A verified leadership session and the live employee directory are required.');
    }
    const { data, error } = await supabaseRaw.functions.invoke('employee-test-account', {
      body: { action, employeeId, ...(password === undefined ? {} : { password }) },
    });
    if (error) {
      const context = error.context;
      const status = context instanceof Response ? context.status : undefined;
      let detail: string | undefined;
      if (context instanceof Response) {
        try {
          const body: unknown = await context.clone().json();
          if (body && typeof body === 'object') {
            const value = (body as Record<string, unknown>).error ?? (body as Record<string, unknown>).message;
            if (typeof value === 'string') detail = value;
          }
        } catch { /* A gateway error may not have a JSON body. */ }
      }
      console.error('Employee account setup request failed:', {
        action, status, detail, errorName: error.name, errorMessage: error.message,
      });
      throw new Error(status
        ? `Account setup request failed (HTTP ${status}): ${detail || error.message}`
        : `Account setup request failed before an HTTP response: ${error.message}`);
    }
    if (!data || (data.status !== 'ready' && data.status !== 'pending')) {
      throw new Error('Unexpected account setup response.');
    }
    return data as TestAccountStatus & { temporaryPassword?: string };
  };

  const generateTestPassword = async (employeeId: string): Promise<GeneratedTestPassword> => {
    const result = await invokeTestAccount('generate_test_password', employeeId);
    if (result.status !== 'ready' || !result.authId || !result.authEmail
      || typeof result.temporaryPassword !== 'string' || result.temporaryPassword.length < 12) {
      throw new Error('Unexpected temporary test password response. Check account status before retrying.');
    }
    return result as GeneratedTestPassword;
  };

  // TEMPORARY TRANSITION FEATURE — see the constants near the top of this file. Same
  // error-shaping pattern as invokeTestAccount above, against the separate
  // employee-impersonation function.
  const invokeImpersonation = async (
    employeeId: string
  ): Promise<{ sessionId: string; hashedToken: string; employeeAuthId: string; employeeEmail: string }> => {
    if (!canAccessImpersonation || !usersLoadedFromSupabase) {
      throw new Error('A verified leadership session and the live employee directory are required.');
    }
    const { data, error } = await supabaseRaw.functions.invoke('employee-impersonation', {
      body: { action: 'start', employeeId },
    });
    if (error) {
      const context = error.context;
      const status = context instanceof Response ? context.status : undefined;
      let detail: string | undefined;
      if (context instanceof Response) {
        try {
          const body: unknown = await context.clone().json();
          if (body && typeof body === 'object') {
            const value = (body as Record<string, unknown>).error ?? (body as Record<string, unknown>).message;
            if (typeof value === 'string') detail = value;
          }
        } catch { /* A gateway error may not have a JSON body. */ }
      }
      console.error('Employee impersonation request failed:', {
        status, detail, errorName: error.name, errorMessage: error.message,
      });
      throw new Error(status
        ? `Impersonation request failed (HTTP ${status}): ${detail || error.message}`
        : `Impersonation request failed before an HTTP response: ${error.message}`);
    }
    if (!data?.sessionId || !data?.hashedToken || !data?.employeeAuthId || !data?.employeeEmail) {
      throw new Error('Unexpected impersonation response.');
    }
    return data as { sessionId: string; hashedToken: string; employeeAuthId: string; employeeEmail: string };
  };

  const handleStartEmployeeTest = async (employee: UserRecord, account: TestAccountStatus) => {
    if (!canAccessTestingMode || !account.authId || !account.authEmail) throw new Error('Account is not ready.');
    const fresh = await invokeTestAccount('status', employee.id);
    if (fresh.status !== 'ready' || fresh.authId !== account.authId || fresh.authEmail !== account.authEmail) {
      throw new Error('Account status changed. Check it again before continuing.');
    }
    // This marker only controls the test banner. It contains no token or password.
    const handoff: TestHandoff = { employeeId: employee.id, authId: fresh.authId, email: fresh.authEmail };
    sessionStorage.setItem(TEST_SESSION_KEY, JSON.stringify(handoff));
    const { error } = await supabase.auth.signOut();
    if (error) {
      sessionStorage.removeItem(TEST_SESSION_KEY);
      throw new Error('Could not sign out of the admin session. No employee session was started.');
    }
    localStorage.removeItem('agency_auth_user_id');
    setTestHandoff(handoff);
    setAuthenticatedUser(null);
    setSupabaseSessionUser(null);
    setVerifiedTesterId(null);
    setIsTestingSelectorOpen(false);
    setUnauthorizedRoute(null);
    window.location.hash = '#login';
  };

  const handleExitEmployeeTest = async () => {
    if (!testHandoff || !authenticatedUser) return;
    const { error } = await supabase.auth.signOut();
    if (error) {
      showNotification('Could not sign out of the employee session. Please retry.', 'info');
      return;
    }
    sessionStorage.removeItem(TEST_SESSION_KEY);
    localStorage.removeItem('agency_auth_user_id');
    setTestHandoff(null);
    setVerifiedTestAuthId(null);
    setAuthenticatedUser(null);
    setSupabaseSessionUser(null);
    setUnauthorizedRoute(null);
    window.location.hash = '#login';
  };

  // TEMPORARY TRANSITION FEATURE — see the constants near the top of this file. Unlike Testing
  // Mode's start (which requires the admin to sign out and manually re-authenticate as the
  // employee on the normal login screen with a real password), verifyOtp establishes the
  // employee's session directly: there is no password step at all, and no intermediate
  // "signed out of everything" state — if the magic link fails to verify, the admin's own session
  // is simply left untouched.
  const handleStartImpersonation = async (employee: UserRecord) => {
    if (!canAccessImpersonation) throw new Error('Not authorized to impersonate employees.');
    const { sessionId, hashedToken, employeeAuthId, employeeEmail } = await invokeImpersonation(employee.id);
    const { error: otpError } = await supabase.auth.verifyOtp({ token_hash: hashedToken, type: 'magiclink' });
    if (otpError) {
      throw new Error(`Could not start the impersonation session: ${otpError.message}`);
    }
    // This marker only controls the impersonation banner. It contains no token.
    const handoff: ImpersonationHandoff = { employeeId: employee.id, authId: employeeAuthId, email: employeeEmail, sessionId };
    sessionStorage.setItem(IMPERSONATION_SESSION_KEY, JSON.stringify(handoff));
    setImpersonationHandoff(handoff);
    setIsImpersonationSelectorOpen(false);
    setUnauthorizedRoute(null);
    // onAuthStateChange's SIGNED_IN handler resolves authenticatedUser to the employee's own row
    // once the new session lands; jump straight to their default portal rather than leaving the
    // admin's last-viewed tab showing (which the employee's role may not even have access to).
    const roleMeta = getRoleInfo(employee.role);
    setActiveTab(roleMeta.defaultModule);
    window.location.hash = `#/portal/${roleMeta.portalSlug}/${roleMeta.defaultModule}`;
  };

  // TEMPORARY TRANSITION FEATURE — closes the impersonation_sessions audit row while still
  // authenticated AS the employee (the one moment this app's single Auth session can satisfy
  // impersonation_sessions_close_rls's employee_auth_id branch — see that migration's comment),
  // then signs out and returns to the login screen for the admin to sign back in with their own
  // real password, exactly like Testing Mode's own exit.
  const handleExitImpersonation = async () => {
    if (!impersonationHandoff || !authenticatedUser) return;
    try {
      await supabaseRaw.from('impersonation_sessions')
        .update({ ended_at: new Date().toISOString(), ended_reason: 'manual_exit' })
        .eq('id', impersonationHandoff.sessionId)
        .is('ended_at', null);
    } catch (err) {
      // Best-effort: the admin's own next login self-heals any row left open (see
      // handleLoginSuccess below) via impersonation_sessions_close_rls's admin_auth_id branch.
      console.warn('Could not close impersonation audit record:', err);
    }
    const { error } = await supabase.auth.signOut();
    if (error) {
      showNotification('Could not sign out of the impersonation session. Please retry.', 'info');
      return;
    }
    sessionStorage.removeItem(IMPERSONATION_SESSION_KEY);
    localStorage.removeItem('agency_auth_user_id');
    setImpersonationHandoff(null);
    setVerifiedImpersonationAuthId(null);
    setAuthenticatedUser(null);
    setSupabaseSessionUser(null);
    setUnauthorizedRoute(null);
    window.location.hash = '#login';
  };

  const handleLoginSuccess = (user: UserRecord) => {
    setVerifiedTesterId(null);
    setVerifiedImpersonatorId(null);
    setAuthenticatedUser(user);
    setSupabaseSessionUser(user);
    setUnauthorizedRoute(null);
    const roleMeta = getRoleInfo(user.role);
    setActiveTab(roleMeta.defaultModule);
    window.location.hash = `#/portal/${roleMeta.portalSlug}/${roleMeta.defaultModule}`;
    showNotification(`Welcome, ${user.name} (${roleMeta.portalTitleEn})`);
    // TEMPORARY TRANSITION FEATURE self-heal: impersonation has no auto-expiry, so a session left
    // open by a closed tab (Exit never clicked) would otherwise stay open forever. This admin's
    // own next real login is the one other moment impersonation_sessions_close_rls's identity
    // check can be satisfied (its admin_auth_id branch) — best-effort, never blocks login.
    if (EMPLOYEE_IMPERSONATION_ENABLED && canImpersonateEmployees(user.role) && isSupabaseConfigured()) {
      supabaseRaw.from('impersonation_sessions')
        .update({ ended_at: new Date().toISOString(), ended_reason: 'admin_override' })
        .eq('admin_user_id', user.id)
        .is('ended_at', null)
        .then(({ error }) => {
          if (error) console.warn('Could not self-heal stale impersonation sessions:', error);
        });
    }
  };

  // SetPasswordScreen's onComplete: supabase.auth.updateUser({ password })
  // already succeeded, so this is now a normal session — resolve it to the
  // matching employee row and finish login exactly like a real sign-in,
  // same as restoreSession()/onAuthStateChange do elsewhere in this file.
  const handlePasswordRecoveryComplete = async () => {
    setIsPasswordRecovery(false);
    try {
      const { data: { session } } = await supabase.auth.getSession();
      if (session?.user) {
        // This lookup happens before the employee-shaped client-side session
        // has been established. Use the raw client so the legacy users proxy
        // cannot fall back to INITIAL_USERS and miss a real production user.
        const { data: dbUser } = await supabaseRaw
          .from('users')
          .select('*')
          .eq('auth_id', session.user.id)
          .single();
        if (dbUser && !dbUser.deactivated_at) {
          handleLoginSuccess(dbUser as UserRecord);
          return;
        }
      }
    } catch (err) {
      console.warn('Post-recovery session lookup warning:', err);
    }
    // Couldn't resolve the matching employee row — sign out rather than
    // leaving them stuck on a blank/broken screen.
    await supabase.auth.signOut();
  };

  const handleLogout = async () => {
    sessionStorage.removeItem(TEST_SESSION_KEY);
    setTestHandoff(null);
    setVerifiedTestAuthId(null);
    setVerifiedTesterId(null);
    setIsTestingSelectorOpen(false);
    sessionStorage.removeItem(IMPERSONATION_SESSION_KEY);
    setImpersonationHandoff(null);
    setVerifiedImpersonationAuthId(null);
    setVerifiedImpersonatorId(null);
    setIsImpersonationSelectorOpen(false);
    try {
      if (isSupabaseConfigured()) {
        await supabase.auth.signOut();
      }
    } catch (err) {
      console.warn('Supabase logout error:', err);
    }
    try {
      localStorage.removeItem('agency_auth_user_id');
    } catch {}
    setAuthenticatedUser(null);
    setSupabaseSessionUser(null);
    setUnauthorizedRoute(null);
    window.location.hash = '#login';
    showNotification('Signed out successfully.');
  };

  // Fetch initial data directly from Supabase (or fallback to initial state)
  //
  // Does NOT clear `clients` to [] before refetching (it used to) — that premature wipe
  // made every ClientDashboard/DynamicBriefForm consumer that does `clients.find(id) || null`
  // (ServiceBriefsRoutingView, AMQueue, SalesPortalView, CampaignManagementModule) briefly see
  // no match and unmount, discarding any unsaved brief-form input. `clients` now simply keeps
  // its last-known-good value until setClients() below replaces it with fresh data — a plain
  // replace, not a clear-then-refill. No UI depends on clients.length === 0 as a loading signal.
  const loadData = useCallback(async () => {
    setLoading(true);
    setUsersLoadedFromSupabase(false);
    const configured = isSupabaseConfigured();
    setSupabaseActive(configured);

    // 1. Fetch employees directly from Postgres (bypassing the legacy client-side
    // users proxy in lib/supabase.ts — real RLS on public.users is the actual
    // security boundary, and that proxy's own fallback path can mask a real
    // Supabase error as a false success backed by mock data).
    try {
      if (authenticatedUser) {
        const { data: userData, error: userErr } = await supabaseRaw.from('users').select('*');
        if (userErr) {
          console.error('Failed to load employees from Supabase:', userErr);
          showNotification(`Failed to load employees from the server: ${userErr.message}`, 'info');
        } else {
          setUsers((userData as UserRecord[]) || []);
          setUsersLoadedFromSupabase(true);
        }
      } else {
        setUsers(INITIAL_USERS);
      }
    } catch (err: any) {
      console.error('Error fetching employees from Supabase:', err);
      showNotification(`Failed to load employees from the server: ${err?.message || 'Unknown error'}`, 'info');
    }

    if (configured) {
      try {
        // Fetch clients
        const { data: clientData, error: clientErr } = await supabaseRaw.from('clients').select('*');
        if (clientErr) {
          console.error('Failed to load clients from Supabase:', clientErr);
          showNotification(`Failed to load clients from the server: ${clientErr.message}`, 'info');
        } else {
          setClients(((clientData as ClientRecord[]) || []).map((client) => ({
            ...client, services: normalizeClientServices(client.services),
          })));
        }

        // Fetch briefs
        const { data: briefData, error: briefErr } = await supabase.from('briefs').select('*');
        if (!briefErr && briefData && briefData.length > 0) {
          setBriefs(briefData as BriefRecord[]);
        }

        // Fetch brief revision history
        const { data: briefRevisionData, error: briefRevisionErr } = await supabase
          .from('brief_revisions')
          .select('*');
        if (!briefRevisionErr && briefRevisionData && briefRevisionData.length > 0) {
          setBriefRevisions(briefRevisionData as BriefRevisionRecord[]);
        }

        // Fetch the global brief field schema (source of truth moved here from a static import)
        const { data: briefFieldSchemaData, error: briefFieldSchemaErr } = await supabase
          .from('brief_field_schemas')
          .select('*');
        if (!briefFieldSchemaErr && briefFieldSchemaData) {
          setBriefFieldSchemaRows(briefFieldSchemaData as BriefFieldSchemaRow[]);
        }

        // Fetch tasks
        const { data: taskData, error: taskErr } = await supabaseRaw.from('tasks').select('*');
        if (taskErr) {
          console.error('Failed to load tasks from Supabase:', taskErr);
          showNotification(`Failed to load tasks from the server: ${taskErr.message}`, 'info');
        } else {
          setTasks((taskData as TaskRecord[]) || []);
        }

        // Fetch task comments
        const { data: taskCommentData, error: taskCommentErr } = await supabase
          .from('task_comments')
          .select('*');
        if (!taskCommentErr && taskCommentData && taskCommentData.length > 0) {
          setTaskComments(taskCommentData as TaskCommentRecord[]);
        }

        // Fetch task attachment metadata (the files themselves stay in Storage)
        const { data: taskAttachmentData, error: taskAttachmentErr } = await supabase
          .from('task_attachments')
          .select('*');
        if (!taskAttachmentErr && taskAttachmentData && taskAttachmentData.length > 0) {
          setTaskAttachments(taskAttachmentData as TaskAttachmentRecord[]);
        }

        // Fetch capacity_logs
        const { data: capData, error: capErr } = await supabase.from('capacity_logs').select('*');
        if (!capErr && capData && capData.length > 0) {
          setCapacityLogs(capData as CapacityLogRecord[]);
        }

        // Fetch daily_logs
        const { data: logData, error: logErr } = await supabase.from('daily_logs').select('*');
        if (!logErr && logData && logData.length > 0) {
          setDailyLogs(logData as DailyLogRecord[]);
        }

        // Fetch extra_notes
        const { data: noteData, error: noteErr } = await supabase.from('extra_notes').select('*');
        if (!noteErr && noteData && noteData.length > 0) {
          setExtraNotes(noteData as ExtraNoteRecord[]);
        }

        // Fetch campaigns
        const { data: campaignData, error: campaignErr } = await supabase.from('campaigns').select('*');
        if (!campaignErr && campaignData && campaignData.length > 0) {
          setCampaigns(campaignData as CampaignRecord[]);
        }

        // Fetch assignments (service specialist delegation records)
        const { data: assignmentData, error: assignmentErr } = await supabase.from('assignments').select('*');
        if (!assignmentErr && assignmentData && assignmentData.length > 0) {
          setAssignments(assignmentData as AssignmentRecord[]);
        }

        // Fetch social_insights (Reporting Engine: social media comparison indicators)
        const { data: socialInsightData, error: socialInsightErr } = await supabase
          .from('social_insights')
          .select('*');
        if (!socialInsightErr && socialInsightData && socialInsightData.length > 0) {
          setSocialInsights(socialInsightData as SocialInsightRecord[]);
        }

        // Fetch reports (Reporting Engine)
        const { data: reportData, error: reportErr } = await supabase.from('reports').select('*');
        if (!reportErr && reportData && reportData.length > 0) {
          setReports(reportData as ReportRecord[]);
        }

        // Fetch client_comparisons (Reporting Engine)
        const { data: comparisonData, error: comparisonErr } = await supabase
          .from('client_comparisons')
          .select('*');
        if (!comparisonErr && comparisonData && comparisonData.length > 0) {
          setClientComparisons(comparisonData as ClientComparisonRecord[]);
        }

        // Fetch client_portal_users (Client Portal: invite/claim status for the AM-side UI)
        const { data: portalUserData, error: portalUserErr } = await supabase
          .from('client_portal_users')
          .select('*');
        if (!portalUserErr && portalUserData && portalUserData.length > 0) {
          setClientPortalUsers(portalUserData as ClientPortalUserRecord[]);
        }

        // Fetch meetings (Module 9 scaffolding: AM meeting recordings/manual transcript notes)
        const { data: meetingData, error: meetingErr } = await supabase.from('meetings').select('*');
        if (!meetingErr && meetingData && meetingData.length > 0) {
          setMeetings(meetingData as MeetingRecord[]);
        }

        // Fetch client_contracts (Module 12 Phase 6: Sales's signed-contract upload)
        const { data: contractData, error: contractErr } = await supabase.from('client_contracts').select('*');
        if (!contractErr && contractData && contractData.length > 0) {
          setClientContracts(contractData as ClientContractRecord[]);
        }

        // Fetch platform_connections (Module 6 scaffolding: manual integration status tracker)
        const { data: platformConnectionData, error: platformConnectionErr } = await supabase
          .from('platform_connections')
          .select('*');
        if (!platformConnectionErr && platformConnectionData && platformConnectionData.length > 0) {
          setPlatformConnections(platformConnectionData as PlatformConnectionRecord[]);
        }

      } catch (err) {
        console.warn('Supabase query error, relying on local cached state:', err);
      }
    }
    setLoading(false);
    // authenticatedUser?.id (not the whole object) — loadData's body only ever checks
    // `if (authenticatedUser)` truthy, so the only thing that should make it refetch is an
    // actual login/logout/user-switch. Depending on the full object made it refetch (and, via
    // the now-removed setClients([]) above, briefly unmount any open brief form) on every
    // SIGNED_IN/TOKEN_REFRESHED re-notification Supabase's own client fires on tab refocus,
    // even for the same already-logged-in person — see the effect below that calls loadData().
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [authenticatedUser?.id]);

  // chat_messages, chat_directory, and notifications load independently of loadData's big
  // sequential fetch batch above — deliberately not awaited inside it. That batch runs ~20
  // fetches one after another in a single try block, so if any one of them hangs or throws at
  // the network layer (rather than resolving with a clean {error}), everything sequenced after
  // it never runs — chat/notification data would then silently depend on its position in an
  // entirely unrelated fetch list. Firing these as their own effect means they load — and the
  // poll/Realtime effects below have something to refresh — regardless of what happens in that
  // other batch. notifications was never wired to real Postgres before this (it had neither a
  // fetch nor real mark-as-read) — this is that missing piece, matching the pattern chat got.
  useEffect(() => {
    const userId = authenticatedUser?.id;
    if (!userId || !supabaseActive) return;
    let cancelled = false;

    (async () => {
      try {
        // supabaseRaw, not the wrapped client — chat_messages isn't one of the 4 tables the
        // legacy proxy wraps, but every real-data table access goes through the same explicit,
        // unambiguous client. Sets state even on an empty result (no ">0" guard, unlike most of
        // loadData's fetches) since chat has no demo seed data to protect — a real employee
        // with zero messages should see zero, not a stale local echo.
        const { data: chatData, error: chatErr } = await supabaseRaw
          .from('chat_messages')
          .select('*')
          .or(`sender_id.eq.${userId},receiver_id.eq.${userId}`)
          .order('created_at', { ascending: true });
        if (!cancelled && !chatErr && chatData) {
          setChatMessages(chatData as ChatMessageRecord[]);
        }
      } catch (err) {
        console.warn('Failed to load chat_messages:', err);
      }
    })();

    (async () => {
      try {
        const { data: clearData, error: clearErr } = await supabaseRaw
          .from('chat_conversation_clears')
          .select('*')
          .eq('user_id', userId);
        if (!cancelled && !clearErr && clearData) {
          setChatConversationClears(clearData as ChatConversationClearRecord[]);
        }
      } catch (err) {
        console.warn('Failed to load chat conversation clears:', err);
      }
    })();

    (async () => {
      try {
        // Org-wide chat directory (id/name/role only) via the chat_directory() RPC —
        // deliberately bypasses users_select_rls's employee_visible() scoping, since messaging
        // has no role/team restriction. Real-world testing (Toqa/Shahd) confirmed MiniChat's
        // colleague list was silently narrowed to whatever `users` itself was scoped to; this
        // RPC is the fix, not a change to `users` or employee_visible().
        const { data: directoryData, error: directoryErr } = await supabaseRaw.rpc('chat_directory');
        if (!cancelled && !directoryErr && directoryData) {
          setChatDirectory(directoryData as ChatDirectoryEntry[]);
        }
      } catch (err) {
        console.warn('Failed to load chat_directory:', err);
      }
    })();

    (async () => {
      try {
        // supabaseRaw — notifications isn't one of the 4 tables the legacy proxy wraps either.
        // Newest-first, matching the order the demo seed data was already constructed in (and
        // what a notification dropdown should show). Sets state even on an empty result, same
        // reasoning as chat_messages above.
        const { data: notificationData, error: notificationErr } = await supabaseRaw
          .from('notifications')
          .select('*')
          .eq('user_id', userId)
          .order('created_at', { ascending: false });
        if (!cancelled && !notificationErr && notificationData) {
          setNotifications((prev) =>
            mergeNotificationsPreservingLocalReads(prev, notificationData as NotificationRecord[])
          );
        }
      } catch (err) {
        console.warn('Failed to load notifications:', err);
      }
    })();

    (async () => {
      try {
        const { data: activityData, error: activityErr } = await supabaseRaw
          .from('activities')
          .select('*')
          .order('created_at', { ascending: false })
          .limit(50);
        if (!cancelled && !activityErr && activityData) {
          setActivities(activityData as ActivityRecord[]);
        }
      } catch (err) {
        console.warn('Failed to load activities:', err);
      }
    })();

    return () => {
      cancelled = true;
    };
    // authenticatedUser?.id (not the whole object) — same reasoning as the realtime effect
    // below: this only needs to refire on an actual login/logout, not on every reference change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [authenticatedUser?.id, supabaseActive]);

  // Split from the loadData-triggering effect below on purpose: this one keeps the module-level
  // session-user mirror (used outside the React tree) fresh on every authenticatedUser update,
  // including a same-person refresh that carries genuinely updated fields (role change,
  // deactivation, a rotated token) — nothing about Supabase's own re-notifications is ignored
  // here. Only loadData()'s re-run (next effect) is decoupled from harmless reference churn.
  useEffect(() => {
    setSupabaseSessionUser(authenticatedUser);
  }, [authenticatedUser]);

  useEffect(() => {
    loadData();
  }, [loadData]);

  // Automated renewal alert (Module 15 Phase 1): fires through the SAME channel every other
  // in-app alert already uses — a persisted notifications row surfaced by NotificationBell — for
  // any client whose renewal_date falls within the next 7 days. Recipients are the roles that
  // actually own a renewal decision: leadership (executive/head_of_technical) plus this client's
  // own AM Team Leader/AM Agent plus the team lead of each service this client is actively
  // subscribed to. Design/Graphics (graphic_designer/video_editor) is explicitly excluded even
  // though the 'social_media' service bundles design/video work — a renewal alert is never
  // relevant to that department. The notification id is deterministic (client id + renewal_date +
  // recipient), so re-running this effect (e.g. after an unrelated client update) never creates a
  // duplicate for the same still-current renewal date — the unique-violation (23505) from a
  // second insert attempt is expected and silently ignored, same as the existing task-notification
  // insert above.
  const renewalAlertsCheckedRef = useRef(false);
  useEffect(() => {
    if (!supabaseActive || renewalAlertsCheckedRef.current) return;
    if (clients.length === 0 || users.length === 0) return;
    renewalAlertsCheckedRef.current = true;

    const checkRenewalAlerts = async () => {
      const now = new Date();
      const in7Days = new Date(now);
      in7Days.setDate(in7Days.getDate() + 7);

      for (const client of clients) {
        if (!client.renewal_date || client.status === 'closed') continue;
        const renewal = new Date(client.renewal_date);
        if (Number.isNaN(renewal.getTime()) || renewal < now || renewal > in7Days) continue;

        const activeServiceLeadRoles = client.services
          .map((service): UserRole | null => {
            if (service === 'seo') return 'seo_team_lead';
            if (service === 'media_buying') return 'media_buying_team_lead';
            if (service === 'social_media') return 'social_media_team_lead';
            return null;
          })
          .filter((role): role is UserRole => role !== null);

        const recipients = users.filter((u) => {
          if (!isActiveEmployee(u)) return false;
          if (u.role === 'graphic_designer' || u.role === 'video_editor') return false;
          return (
            u.role === 'executive' ||
            u.role === 'head_of_technical' ||
            u.role === 'ai_engineer' ||
            u.id === client.am_team_lead_id ||
            u.id === client.am_agent_id ||
            activeServiceLeadRoles.includes(u.role)
          );
        });

        for (const recipient of recipients) {
          try {
            const { error } = await supabaseRaw.from('notifications').insert({
              id: `notif-renewal-${client.id}-${client.renewal_date}-${recipient.id}`,
              user_id: recipient.id,
              sender_id: null,
              title: 'Upcoming Client Renewal',
              message: `${client.name}'s contract is due for renewal on ${client.renewal_date} (within 7 days).`,
              type: 'general',
              is_read: false,
              link_url: null,
              created_at: new Date().toISOString(),
            });
            if (error && error.code !== '23505') throw error;
          } catch (err) {
            console.error('Failed to create renewal alert notification:', err);
          }
        }
      }
    };

    checkRenewalAlerts();
  }, [clients, users, supabaseActive]);

  // Real-time chat delivery (Phase 2). A demo-mode login never calls
  // supabase.auth.signInWithPassword, so there's no real JWT to open an authenticated
  // Realtime channel with — postgres_changes would just receive nothing (no grant for the
  // anon role). Detect that via getSession() and poll instead, so a demo session still sees
  // new messages without a manual refresh. Uses supabaseRaw throughout: channel() is a direct
  // instance method (unlike `.auth`, a plain nested property the legacy proxy passes through
  // safely), so calling it through the wrapped client risks `this` binding to the Proxy
  // instead of the real client instance — supabaseRaw sidesteps that entirely.
  //
  // Real-world testing (Toqa -> Shahd) found a message that persisted correctly but never
  // arrived in Shahd's already-open session — a silent Realtime delivery failure with zero
  // client-side visibility, since subscribe() was called with no status callback at all. Fixed
  // by adding that callback and treating anything other than 'SUBSCRIBED' as a signal to poll:
  // this applies to every session now, not just the demo/no-session case, so a Realtime failure
  // degrades to a worst-case ~9s delay instead of a message that never arrives.
  useEffect(() => {
    const userId = authenticatedUser?.id;
    if (!userId || !supabaseActive) return;

    let intervalId: ReturnType<typeof setInterval> | null = null;
    let channel: ReturnType<typeof supabaseRaw.channel> | null = null;
    let cancelled = false;

    const refetchChatMessages = async () => {
      const { data, error } = await supabaseRaw
        .from('chat_messages')
        .select('*')
        .or(`sender_id.eq.${userId},receiver_id.eq.${userId}`)
        .order('created_at', { ascending: true });
      if (!cancelled && !error) {
        setChatMessages((data as ChatMessageRecord[]) || []);
      }
    };

    const startPollFallback = () => {
      if (intervalId) return; // already polling
      intervalId = setInterval(refetchChatMessages, 9000);
    };
    const stopPollFallback = () => {
      if (intervalId) {
        clearInterval(intervalId);
        intervalId = null;
      }
    };

    (async () => {
      const {
        data: { session },
      } = await supabaseRaw.auth.getSession();
      if (cancelled) return;

      if (!session) {
        startPollFallback();
        return;
      }

      // Two separate listeners, not one — Realtime's `filter` only supports a single-column
      // equality, no OR across columns, so "I'm the sender or the receiver" needs both
      // directions subscribed. That means my own sent message can echo back to me via the
      // sender_id listener; the id-dedup guard below prevents a double-entry against the
      // optimistic local append onSendMessage already does.
      const upsertChatMessage = (payload: { new: ChatMessageRecord }) => {
        const row = payload.new;
        setChatMessages((prev) => {
          const existingIndex = prev.findIndex((message) => message.id === row.id);
          if (existingIndex === -1) return [...prev, row];
          return prev.map((message) => (message.id === row.id ? row : message));
        });
      };
      const removeChatMessage = (payload: RealtimePostgresDeletePayload<ChatMessageRecord>) => {
        const messageId = payload.old.id;
        if (!messageId) return;
        setChatMessages((prev) => prev.filter((message) => message.id !== messageId));
      };

      channel = supabaseRaw
        .channel(`chat_messages:${userId}`)
        .on(
          'postgres_changes',
          { event: 'INSERT', schema: 'public', table: 'chat_messages', filter: `receiver_id=eq.${userId}` },
          upsertChatMessage
        )
        .on(
          'postgres_changes',
          { event: 'INSERT', schema: 'public', table: 'chat_messages', filter: `sender_id=eq.${userId}` },
          upsertChatMessage
        )
        .on(
          'postgres_changes',
          { event: 'UPDATE', schema: 'public', table: 'chat_messages', filter: `receiver_id=eq.${userId}` },
          upsertChatMessage
        )
        .on(
          'postgres_changes',
          { event: 'UPDATE', schema: 'public', table: 'chat_messages', filter: `sender_id=eq.${userId}` },
          upsertChatMessage
        )
        .on(
          'postgres_changes',
          { event: 'DELETE', schema: 'public', table: 'chat_messages', filter: `receiver_id=eq.${userId}` },
          removeChatMessage
        )
        .on(
          'postgres_changes',
          { event: 'DELETE', schema: 'public', table: 'chat_messages', filter: `sender_id=eq.${userId}` },
          removeChatMessage
        )
        .subscribe((status, err) => {
          if (cancelled) return;
          if (status === 'SUBSCRIBED') {
            stopPollFallback();
          } else {
            // TIMED_OUT | CLOSED | CHANNEL_ERROR — realtime isn't confirmed working right now;
            // poll as a resilience fallback rather than going silent. Also covers a connection
            // that drops after initially subscribing successfully.
            console.warn(`Chat realtime channel not subscribed (status: ${status}); polling as fallback.`, err);
            startPollFallback();
          }
        });
    })();

    return () => {
      cancelled = true;
      stopPollFallback();
      if (channel) supabaseRaw.removeChannel(channel);
    };
    // authenticatedUser?.id (not the whole object) — loadData's own refresh cycle produces a
    // new authenticatedUser reference on every reload even when the id is unchanged, and using
    // the full object here would tear down and reopen the channel on every one of those, not
    // just on an actual login/logout.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [authenticatedUser?.id, supabaseActive]);

  // Real-time notification delivery, mirroring the chat effect above exactly (same subscribe
  // status callback + poll fallback resilience, same demo-session detection via getSession()).
  // A separate channel from chat's — a distinct concern — but the same reasoning throughout:
  // notifications only ever needs one filter (user_id = me), unlike chat_messages' two.
  useEffect(() => {
    const userId = authenticatedUser?.id;
    if (!userId || !supabaseActive) return;

    let intervalId: ReturnType<typeof setInterval> | null = null;
    let channel: ReturnType<typeof supabaseRaw.channel> | null = null;
    let cancelled = false;

    const refetchNotifications = async () => {
      const { data, error } = await supabaseRaw
        .from('notifications')
        .select('*')
        .eq('user_id', userId)
        .order('created_at', { ascending: false });
      if (!cancelled && !error) {
        setNotifications((prev) =>
          mergeNotificationsPreservingLocalReads(prev, (data as NotificationRecord[]) || [])
        );
      }
    };

    const startPollFallback = () => {
      if (intervalId) return;
      intervalId = setInterval(refetchNotifications, 9000);
    };
    const stopPollFallback = () => {
      if (intervalId) {
        clearInterval(intervalId);
        intervalId = null;
      }
    };

    (async () => {
      const {
        data: { session },
      } = await supabaseRaw.auth.getSession();
      if (cancelled) return;

      if (!session) {
        startPollFallback();
        return;
      }

      const upsertNotification = (payload: { new: NotificationRecord }) => {
        const row = payload.new;
        setNotifications((prev) => {
          const existingIndex = prev.findIndex((notification) => notification.id === row.id);
          if (existingIndex === -1) {
            return mergeNotificationsPreservingLocalReads(prev, [row]);
          }
          return prev.map((notification) =>
            notification.id === row.id && !row.is_read &&
            (notification.is_read || locallyReadNotificationIds.current.has(row.id))
              ? { ...row, is_read: true }
              : notification.id === row.id ? row : notification
          );
        });
      };

      channel = supabaseRaw
        .channel(`notifications:${userId}`)
        .on(
          'postgres_changes',
          { event: 'INSERT', schema: 'public', table: 'notifications', filter: `user_id=eq.${userId}` },
          upsertNotification
        )
        .on(
          'postgres_changes',
          { event: 'UPDATE', schema: 'public', table: 'notifications', filter: `user_id=eq.${userId}` },
          upsertNotification
        )
        .subscribe((status, err) => {
          if (cancelled) return;
          if (status === 'SUBSCRIBED') {
            stopPollFallback();
          } else {
            console.warn(`Notifications realtime channel not subscribed (status: ${status}); polling as fallback.`, err);
            startPollFallback();
          }
        });
    })();

    return () => {
      cancelled = true;
      stopPollFallback();
      if (channel) supabaseRaw.removeChannel(channel);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [authenticatedUser?.id, supabaseActive]);

  // Real-time activities delivery, mirroring the chat/notifications effects above.
  useEffect(() => {
    const userId = authenticatedUser?.id;
    if (!userId || !supabaseActive) return;

    let intervalId: ReturnType<typeof setInterval> | null = null;
    let channel: ReturnType<typeof supabaseRaw.channel> | null = null;
    let cancelled = false;

    const refetchActivities = async () => {
      const { data, error } = await supabaseRaw
        .from('activities')
        .select('*')
        .order('created_at', { ascending: false })
        .limit(50);
      if (!cancelled && !error) {
        setActivities((data as ActivityRecord[]) || []);
      }
    };

    const startPollFallback = () => {
      if (intervalId) return;
      intervalId = setInterval(refetchActivities, 9000);
    };
    const stopPollFallback = () => {
      if (intervalId) {
        clearInterval(intervalId);
        intervalId = null;
      }
    };

    (async () => {
      const {
        data: { session },
      } = await supabaseRaw.auth.getSession();
      if (cancelled) return;

      if (!session) {
        startPollFallback();
        return;
      }

      const insertActivity = (payload: { new: ActivityRecord }) => {
        const row = payload.new;
        setActivities((prev) => {
          const existingIndex = prev.findIndex((activity) => activity.id === row.id);
          if (existingIndex === -1) {
            return [row, ...prev].slice(0, 50); // Keep only latest 50
          }
          return prev;
        });
      };

      channel = supabaseRaw
        .channel(`activities_global`)
        .on(
          'postgres_changes',
          { event: 'INSERT', schema: 'public', table: 'activities' },
          insertActivity
        )
        .subscribe((status, err) => {
          if (cancelled) return;
          if (status === 'SUBSCRIBED') {
            stopPollFallback();
          } else {
            console.warn(`Activities realtime channel not subscribed (status: ${status}); polling as fallback.`, err);
            startPollFallback();
          }
        });
    })();

    return () => {
      cancelled = true;
      stopPollFallback();
      if (channel) supabaseRaw.removeChannel(channel);
    };
  }, [authenticatedUser?.id, supabaseActive]);

  // Real-time online users (Presence) & heartbeat
  useEffect(() => {
    if (!authenticatedUser || !supabaseActive) return;

    // 1. Setup Presence Channel
    const channel = supabaseRaw.channel('online-users', {
      config: {
        presence: { key: authenticatedUser.id },
      },
    });

    channel
      .on('presence', { event: 'sync' }, () => {
        const newState = channel.presenceState();
        const onlineIds = Object.keys(newState);
        setOnlineUserIds(onlineIds);
      })
      .subscribe(async (status) => {
        if (status === 'SUBSCRIBED') {
          await channel.track({ online_at: new Date().toISOString() });
        }
      });

    // 2. Heartbeat to update last_seen_at in DB
    const updateLastSeen = async () => {
      try {
        await supabaseRaw.from('users').update({ last_seen_at: new Date().toISOString() }).eq('id', authenticatedUser.id);
      } catch (err) {
        console.warn('Failed to update last_seen_at heartbeat', err);
      }
    };

    // Update immediately on mount, then every 3 minutes
    updateLastSeen();
    const heartbeatInterval = setInterval(updateLastSeen, 3 * 60 * 1000);

    return () => {
      clearInterval(heartbeatInterval);
      supabaseRaw.removeChannel(channel);
    };
    // authenticatedUser?.id — this effect only ever reads .id, but depending on the full object
    // tore down and recreated the presence channel (and its heartbeat interval) on every
    // reference-only update, briefly flickering this user offline/online for everyone else on a
    // tab refocus. An actual login/logout/user-switch is the only thing that should do that.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [authenticatedUser?.id, supabaseActive]);

  // allowedRoles is a list rather than a single role because the "Account Manager" slot accepts
  // either an am_agent OR an am_team_lead self-assigning as the responsible person — the
  // "Account Management Lead" slot still only ever passes ['am_team_lead'].
  const validateClientAssignment = async (
    id: string | null | undefined,
    allowedRoles: UserRole[],
    fieldLabel: string
  ) => {
    if (!id) return null;
    const { data, error } = await supabaseRaw.from('users').select('id, role, auth_id, deactivated_at').eq('id', id).single();
    if (error) throw error;
    if (!data || !allowedRoles.includes(data.role as UserRole) || !isActiveEmployee(data as UserRecord)) {
      throw new Error(`Selected ${fieldLabel} is not an active employee.`);
    }
    return data.id as string;
  };

  // Shared by both registration paths below (single + bulk): fires the two registration-time
  // notifications neither path had before. (1) the assigned AM Team Lead/Agent, if one was set at
  // registration — skipped when that person is the one who just registered/self-assigned the
  // client, since notifying someone about their own action is noise, not signal. (2) every active
  // Team Lead of each service this client subscribed to — since neither registration form collects
  // a service-specific (SEO/Media Buying/Social Media) assignment, every such service starts
  // unassigned every time, so this always fires for every active service. Reuses the exact
  // service_type -> team_lead role mapping the renewal-alert effect and the brief-submission
  // notification (handleSubmitBrief) already established, and the same deterministic-id +
  // swallowed-23505 idempotency pattern so a retried registration call can never double-notify.
  const notifyOnClientRegistration = async (client: ClientRecord) => {
    if (!supabaseActive) return;

    if (client.am_team_lead_id && client.am_team_lead_id !== currentUser.id) {
      try {
        const { error } = await supabaseRaw.from('notifications').insert({
          id: `notif-client-registered-am-lead-${client.id}-${client.am_team_lead_id}`,
          user_id: client.am_team_lead_id,
          sender_id: currentUser.id,
          title: 'New Client Assigned',
          message: `You have been assigned as AM Team Leader for the new client "${client.name}".`,
          type: 'general',
          is_read: false,
          link_url: 'module:onboarding',
          created_at: new Date().toISOString(),
        });
        if (error && error.code !== '23505') throw error;
      } catch (err) {
        console.error('Failed to create client-registration AM Team Lead notification:', err);
      }
    }

    if (client.am_agent_id && client.am_agent_id !== currentUser.id) {
      try {
        const { error } = await supabaseRaw.from('notifications').insert({
          id: `notif-client-registered-am-agent-${client.id}-${client.am_agent_id}`,
          user_id: client.am_agent_id,
          sender_id: currentUser.id,
          title: 'New Client Assigned',
          message: `You have been assigned as Account Manager for the new client "${client.name}".`,
          type: 'general',
          is_read: false,
          link_url: 'module:onboarding',
          created_at: new Date().toISOString(),
        });
        if (error && error.code !== '23505') throw error;
      } catch (err) {
        console.error('Failed to create client-registration AM Agent notification:', err);
      }
    }

    const activeServiceLeadRoles = normalizeClientServices(client.services)
      .map((service): UserRole | null => {
        if (service === 'seo') return 'seo_team_lead';
        if (service === 'media_buying') return 'media_buying_team_lead';
        if (service === 'social_media') return 'social_media_team_lead';
        return null;
      })
      .filter((role): role is UserRole => role !== null);

    for (const teamLeadRole of activeServiceLeadRoles) {
      const recipients = users.filter((u) => u.role === teamLeadRole && isActiveEmployee(u));
      for (const recipient of recipients) {
        try {
          const { error } = await supabaseRaw.from('notifications').insert({
            id: `notif-client-registered-service-${client.id}-${teamLeadRole}-${recipient.id}`,
            user_id: recipient.id,
            sender_id: currentUser.id,
            title: 'New Client Needs a Specialist',
            message: `New client "${client.name}" subscribed to your department's service and has no specialist assigned yet.`,
            type: 'general',
            is_read: false,
            link_url: 'module:service_briefs',
            created_at: new Date().toISOString(),
          });
          if (error && error.code !== '23505') throw error;
        } catch (err) {
          console.error('Failed to create client-registration Team Lead notification:', err);
        }
      }
    }
  };

  // 1. Single-client registration (ClientRegistrationModal.tsx) — shared by permitted roles.
  // Sales retains its onboarding handoff. Management may register an onboarding client
  // with either AM assignment, both, or neither. AM Agents retain their active-client path.
  const handleRegisterClient = async (clientData: {
    name: string;
    client_contact_name?: string;
    sector: ClientSector;
    industry: string;
    services: ServiceType[];
    phone_number?: string;
    website_or_social_link?: string;
    contract_value: number;
    due_value?: number;
    remaining_value?: number;
    start_date: string;
    contract_duration_months?: number;
    renewal_date: string;
    am_team_lead_id?: string;
    am_agent_id?: string;
    notes?: string;
  }, contractFile: File | null) => {
    if (!canRegisterClients) throw new Error('You do not have permission to register clients.');
    const isAmRegistration = currentUser.role === 'am_team_lead' || currentUser.role === 'am_agent';
    const isManagementRegistration = currentUser.role === 'executive' || currentUser.role === 'head_of_technical' || currentUser.role === 'ai_engineer' || currentUser.role === 'am_team_lead';
    if (!supabaseActive) throw new Error('Supabase is not configured; the client was not created.');
    // Every role submits an auto-resolved id (or none) from ClientRegistrationModal's
    // soleActiveAmTeamLeadId logic now — no role picks an AM Team Lead manually anymore. Still
    // validated rather than trusted, same defensive reasoning as any other client-submitted id.
    const leadId = await validateClientAssignment(clientData.am_team_lead_id, ['am_team_lead'], 'AM Team Leader');
    const agentId = isManagementRegistration
      ? await validateClientAssignment(clientData.am_agent_id, ['am_team_lead', 'am_agent'], 'Account Manager')
      : currentUser.role === 'am_agent' ? currentUser.id : null;
    const newClientPayload: Partial<ClientRecord> = {
      id: `cl-${Date.now().toString().slice(-4)}`,
      name: clientData.name,
      client_contact_name: clientData.client_contact_name || null,
      sector: clientData.sector,
      industry: clientData.industry,
      services: normalizeClientServices(clientData.services),
      phone_number: clientData.phone_number || null,
      website_or_social_link: clientData.website_or_social_link || null,
      status: isManagementRegistration ? 'onboarding' : isAmRegistration ? 'active' : 'onboarding',
      sales_owner_id: isAmRegistration || isManagementRegistration ? null : currentUser.id,
      am_agent_id: agentId,
      am_agent_assigned_at: agentId ? new Date().toISOString() : null,
      am_team_lead_id: leadId,
      contract_value: clientData.contract_value,
      due_value: clientData.due_value ?? null,
      remaining_value: clientData.remaining_value ?? null,
      start_date: clientData.start_date,
      contract_duration_months: clientData.contract_duration_months ?? null,
      renewal_date: clientData.renewal_date,
      notes: clientData.notes || null,
      created_at: new Date().toISOString(),
    };

    let persistedClient: ClientRecord;
    try {
      const { data, error } = await supabaseRaw.from('clients').insert([newClientPayload]).select();
      if (error) throw error;
      if (!data?.[0]) throw new Error('Client creation returned no persisted row.');
      persistedClient = data[0] as ClientRecord;
    } catch (err) {
      console.error('Supabase error inserting client:', err);
      throw err;
    }
    setClients((prev) => [persistedClient, ...prev]);
    await notifyOnClientRegistration(persistedClient);

    // Optional contract file — if the AM/Sales rep already has it in hand, this reuses the exact
    // same upload path (Storage bucket + client_contracts table insert) every post-registration
    // "Signed Contract" upload already goes through, so nothing is added or duplicated to add it
    // later instead. Left un-caught here on purpose when a file was provided: a failure must
    // surface to the modal's own error banner rather than being silently swallowed like the
    // notification side-effects above — the client row and notifications have already succeeded
    // either way, and the contract can still be added afterward from the client dashboard.
    if (contractFile) {
      await handleUploadClientContract(persistedClient.id, contractFile);
    }

    await logActivity('create', 'client', persistedClient.id, persistedClient.name, `Registered new client in ${persistedClient.industry}`);

    showNotification(
      isManagementRegistration
        ? `Client "${clientData.name}" registered for onboarding.`
        : isAmRegistration
          ? `Client "${clientData.name}" added as an active account under your management.`
          : `Client "${clientData.name}" registered and routed to Account Management.`
    );
  };

  // 1a2. Bulk-upload client insert (BulkClientUploadModal.tsx), one row at a time. Deliberately
  // separate from handleRegisterClient rather than reused by it: this re-throws a real Supabase
  // error instead of swallowing it and falling back to local state, the same re-throw-on-error
  // contract handleAddEmployee already gives EmployeeAdminHub's bulk uploader, so the modal can
  // catch and report per-row failures (e.g. a constraint violation) individually instead of every
  // row silently "succeeding" locally.
  //
  // Branches on the uploading user's role; the modal resolves optional assignment names to IDs.
  //   - sales: new-pipeline lead, sales_owner_id = self, status starts at 'onboarding' — matches
  //     clients_insert_sales_rls exactly.
  //   - am_agent: an already-active client of their own, am_agent_id = self (agents only manage
  //     their own book), sales_owner_id stays null, status starts at 'active', and
  //     am_agent_assigned_at is stamped now so it isn't invisible to MyWorkHub's gained/lost
  //     metrics from creation.
  //   - management: onboarding client, no sales owner, independent optional AM assignments.
  const handleBulkAddClient = async (clientData: {
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
  }) => {
    if (!canRegisterClients) throw new Error('You do not have permission to register clients.');
    const isAmUpload = currentUser.role === 'am_team_lead' || currentUser.role === 'am_agent';
    const isManagementUpload = currentUser.role === 'executive' || currentUser.role === 'head_of_technical' || currentUser.role === 'ai_engineer' || currentUser.role === 'am_team_lead';
    if (!supabaseActive) throw new Error('Supabase is not configured; the client was not created.');
    const leadId = isManagementUpload
      ? await validateClientAssignment(clientData.am_team_lead_id, ['am_team_lead'], 'AM Team Leader')
      : clientData.am_team_lead_id;
    const agentId = isManagementUpload
      ? await validateClientAssignment(clientData.am_agent_id, ['am_team_lead', 'am_agent'], 'Account Manager')
      : currentUser.role === 'am_agent' ? currentUser.id : null;
    const newClientPayload: Partial<ClientRecord> = {
      id: `cl-${Date.now().toString().slice(-4)}-${Math.random().toString(36).slice(2, 6)}`,
      name: clientData.name,
      client_contact_name: clientData.client_contact_name || null,
      sector: clientData.sector || null,
      industry: clientData.industry,
      services: normalizeClientServices(clientData.services),
      phone_number: clientData.phone_number || null,
      website_or_social_link: clientData.website_or_social_link || null,
      status: isManagementUpload ? 'onboarding' : isAmUpload ? 'active' : 'onboarding',
      sales_owner_id: isAmUpload || isManagementUpload ? null : currentUser.id,
      am_agent_id: agentId,
      am_agent_assigned_at: agentId ? new Date().toISOString() : null,
      am_team_lead_id: leadId,
      contract_value: clientData.contract_value,
      due_value: clientData.due_value ?? null,
      remaining_value: clientData.remaining_value ?? null,
      start_date: clientData.start_date,
      renewal_date: clientData.renewal_date,
      created_at: new Date().toISOString(),
    };

    try {
      const { data, error } = await supabaseRaw.from('clients').insert([newClientPayload]).select();
      if (error) throw error;
      if (!data?.[0]) throw new Error('Client creation returned no persisted row.');
      const persistedClient = data[0] as ClientRecord;
      setClients((prev) => [persistedClient, ...prev]);
      await notifyOnClientRegistration(persistedClient);
    } catch (err) {
      console.error('Supabase bulk client insert error:', err);
      throw err;
    }
  };


  // Unified helper for logging real-time activities across all departments
  const logActivity = async (
    action_type: ActivityRecord['action_type'],
    target_type: ActivityRecord['target_type'],
    target_id: string,
    target_name: string,
    details?: string
  ) => {
    if (!authenticatedUser) return;
    
    const newActivity = {
      id: `act-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`,
      user_id: authenticatedUser.id,
      action_type,
      target_type,
      target_id,
      target_name,
      details: details || null,
      created_at: new Date().toISOString()
    };

    // Optimistic local update
    setActivities((prev) => [newActivity as ActivityRecord, ...prev].slice(0, 50));

    if (isSupabaseConfigured()) {
      try {
        await supabaseRaw.from('activities').insert(newActivity);
      } catch (err) {
        console.warn('Failed to insert activity to Supabase:', err);
      }
    }
  };

  // 1b. Add a new employee (Add Employee admin screen: single form or bulk CSV/Excel upload) —
  // creates a pending employee row (auth_id null). Real Supabase Auth account creation needs the
  // service-role key, which never touches the browser, so it happens separately via
  // scripts/provisionAuthUsers.ts. Unlike most local-fallback handlers in this file, a real
  // Supabase error here is re-thrown rather than swallowed: the bulk uploader in
  // EmployeeAdminHub.tsx depends on catching per-row failures (e.g. a duplicate email hitting
  // users_email_unique) to report them individually instead of silently "succeeding" locally.
  const handleAddEmployee = async (employee: NewEmployeeInput) => {
    const newUserPayload: UserRecord = {
      id: `usr-${Date.now().toString().slice(-4)}-${Math.random().toString(36).slice(2, 6)}`,
      name: employee.name,
      email: employee.email,
      role: employee.role,
      team: employee.team,
      manager_id: employee.manager_id || null,
      capacity_limit: employee.capacity_limit ?? null,
      auth_id: null,
      created_at: new Date().toISOString(),
    };

    if (supabaseActive) {
      // TEMPORARY DIAGNOSTIC LOGGING — remove once the 409 conflict is root-caused.
      console.log('[IMPORT-PAYLOAD] insert payload (safe fields)', {
        id: newUserPayload.id,
        email: newUserPayload.email,
        auth_id: newUserPayload.auth_id,
        name: newUserPayload.name,
        role: newUserPayload.role,
        team: newUserPayload.team,
        manager_id: newUserPayload.manager_id,
        capacity_limit: newUserPayload.capacity_limit,
      });
      // supabaseRaw bypasses the legacy client-side users proxy — that proxy's
      // fallback path can swallow a real Postgres error (e.g. an RLS rejection)
      // and report a false success backed by mock data instead. Real RLS on
      // public.users is what actually enforces this insert.
      const { data, error } = await supabaseRaw.from('users').insert([newUserPayload]).select();
      if (error) {
        // TEMPORARY DIAGNOSTIC LOGGING — remove once the 409 conflict is root-caused.
        console.log('[IMPORT-PGERR] Postgres/PostgREST error on insert', {
          code: (error as any).code,
          message: error.message,
          details: (error as any).details,
          hint: (error as any).hint,
          email: newUserPayload.email,
          id: newUserPayload.id,
        });
        throw error;
      }
      if (!data || data.length === 0) {
        throw new Error('Supabase did not return the inserted employee — the record may not have been saved.');
      }
      setUsers((prev) => [...prev, data[0] as UserRecord]);
    } else {
      setUsers((prev) => [...prev, newUserPayload]);
    }
  };

  const updatePersistedClient = async (clientId: string, updates: Partial<ClientRecord>) => {
    if (!supabaseActive) throw new Error('Supabase is not configured; the client was not updated.');
    const { data, error } = await supabaseRaw
      .from('clients')
      .update(updates)
      .eq('id', clientId)
      .select('*')
      .single();
    if (error) throw error;
    if (!data) throw new Error('Client update returned no persisted row.');
    const persistedClient = data as ClientRecord;
    setClients((prev) => prev.map((client) => client.id === clientId ? persistedClient : client));
  };

  // 2. Assign the client to an Account Manager (AM Agent)
  const handleAssignAMTeamLead = async (clientId: string, leadId: string) => {
    if (!['executive', 'head_of_technical', 'ai_engineer', 'am_team_lead'].includes(currentUser.role)) {
      throw new Error('You do not have permission to assign an AM Team Leader.');
    }
    const validatedId = await validateClientAssignment(leadId, ['am_team_lead'], 'AM Team Leader');
    await updatePersistedClient(clientId, { am_team_lead_id: validatedId, am_team_lead_viewed_at: null });
    showNotification(validatedId ? 'AM Team Leader assignment updated.' : 'AM Team Leader assignment cleared.');
  };

  const handleAssignAMAgent = async (clientId: string, agentId: string) => {
    if (!['executive', 'head_of_technical', 'ai_engineer', 'am_team_lead'].includes(currentUser.role)) {
      throw new Error('You do not have permission to assign an AM Agent.');
    }
    const validatedId = await validateClientAssignment(agentId, ['am_team_lead', 'am_agent'], 'Account Manager');
    // Module 13 Phase 4: only bump am_agent_assigned_at on an actual change of agent — a no-op
    // resubmission of the same agent shouldn't re-date the "gained" moment. Mirrors the
    // reassignment-clears-viewed_at convention from Module 12 Phase 5.
    const existing = clients.find((c) => c.id === clientId);
    const isReassignment = existing?.am_agent_id !== validatedId;
    const assignedAt = validatedId ? (isReassignment ? new Date().toISOString() : existing?.am_agent_assigned_at) : null;

    try {
      await updatePersistedClient(clientId, { am_agent_id: validatedId, am_agent_assigned_at: assignedAt });
    } catch (err) {
      console.error('Supabase assign error:', err);
      showNotification('Unable to assign this client.', 'info');
      throw err;
    }

    const agent = users.find((u) => u.id === validatedId);
    showNotification(validatedId ? `Client assigned to Account Manager: ${agent?.name || validatedId}` : 'Account Manager assignment cleared.');
  };

  // 2b. Transition a client's lifecycle status (Onboarding -> Active <-> Paused -> Renewal -> Closed)
  const handleUpdateClientStatus = async (
    clientId: string,
    newStatus: ClientStatus,
    options?: { churn_reason?: string; renewal_date?: string }
  ) => {
    const updatePayload: Partial<ClientRecord> = { status: newStatus };
    // Field names kept as churn_reason/churned_at (Module 13 only renamed the status VALUE
    // 'churned' -> 'closed', not these columns — see types/database.ts).
    if (newStatus === 'closed') {
      updatePayload.churn_reason = options?.churn_reason || null;
      updatePayload.churned_at = new Date().toISOString();
    }
    if (options?.renewal_date) {
      updatePayload.renewal_date = options.renewal_date;
    }

    try {
      await updatePersistedClient(clientId, updatePayload);
    } catch (err) {
      console.error('Supabase update client status error:', err);
      showNotification('Unable to update this client status.', 'info');
      return;
    }

    const client = clients.find((c) => c.id === clientId);
    await logActivity('status_change', 'client', clientId, client?.name || 'Client', `Status updated to ${newStatus}`);

    showNotification(`Client "${client?.name || clientId}" status updated to ${newStatus}.`);
  };

  // 2a-3. Hard delete a client (point 6/7) — real DELETE, not deactivation, since clients have no
  // login/auth identity concern the way employees do. clients_delete_rls scopes WHO can call this
  // (executive/head_of_technical + all 5 team leads); the actual block-if-any-activity-exists rule
  // is enforced by the DB itself (every one of the 13 referencing tables defaults to ON DELETE NO
  // ACTION) — ClientDashboard.tsx's getClientActivitySummary() pre-checks this so the UI shows
  // exactly what's blocking before ever calling this, but this still fails safely on its own if
  // that pre-check ever misses something.
  const handleDeleteClient = async (clientId: string) => {
    if (!supabaseActive) throw new Error('Supabase is not configured; the client was not deleted.');
    const { data, error } = await supabaseRaw.from('clients').delete().eq('id', clientId).select('id').single();
    if (error || !data) {
      const failure = error || new Error('Client deletion returned no persisted result.');
      console.error('Supabase delete client error:', failure);
      showNotification('Unable to delete this client — it may still have related records.', 'info');
      throw failure;
    }

    setClients((prev) => prev.filter((c) => c.id !== clientId));
    showNotification('Client deleted permanently.');
  };

  // 2a-2. AM Team Lead payment tracking (Module 12 Phase 7) — manually-editable, never
  // auto-computed from anything. Distinct handler from handleUpdateClientStatus since it edits
  // an unrelated field group and shouldn't carry that function's status-transition side effects.
  const handleUpdatePaymentTracking = async (
    clientId: string,
    updates: { due_value?: number | null; remaining_value?: number | null; contract_duration_months?: number | null }
  ) => {
    try {
      await updatePersistedClient(clientId, updates);
    } catch (err) {
      console.error('Supabase update payment tracking error:', err);
      showNotification('Unable to save payment tracking.', 'info');
      return;
    }
    showNotification('Payment tracking updated.');
  };

  // 2a-3. "Client Access": general email, store platform login, social media login, ad account
  // login + setup type, and payment card details — collected during the Brief phase, rendered in
  // ClientDashboard.tsx's Service Briefs tab. All four roles gated by
  // canAccessClientSensitiveInfo (executive/head_of_technical/am_team_lead/am_agent) can edit —
  // routed through the update_client_access() RPC rather than a direct table update, since
  // clients_update_am_assignment_rls (the only general UPDATE policy on clients) doesn't cover
  // am_agent at all. The RPC re-checks the same four-role/own-client rule server-side and scopes
  // the write to exactly these columns. Every field is optional; leaving any/all blank is expected
  // (the client often hasn't shared them yet) and never blocks this save or anything downstream.
  const handleUpdateClientAccess = async (
    clientId: string,
    updates: {
      general_email?: string | null;
      general_email_password?: string | null;
      store_platform_username?: string | null;
      store_platform_password?: string | null;
      social_media_username?: string | null;
      social_media_password?: string | null;
      ad_account_username?: string | null;
      ad_account_password?: string | null;
      ad_account_setup_type?: 'existing' | 'new' | null;
      payment_card_details?: string | null;
    }
  ) => {
    if (!supabaseActive) {
      showNotification('Supabase is not configured; the client was not updated.', 'info');
      return;
    }
    try {
      const { data, error } = await supabaseRaw.rpc('update_client_access', {
        p_client_id: clientId,
        p_general_email: updates.general_email ?? null,
        p_general_email_password: updates.general_email_password ?? null,
        p_store_platform_username: updates.store_platform_username ?? null,
        p_store_platform_password: updates.store_platform_password ?? null,
        p_social_media_username: updates.social_media_username ?? null,
        p_social_media_password: updates.social_media_password ?? null,
        p_ad_account_username: updates.ad_account_username ?? null,
        p_ad_account_password: updates.ad_account_password ?? null,
        p_ad_account_setup_type: updates.ad_account_setup_type ?? null,
        p_payment_card_details: updates.payment_card_details ?? null,
      });
      if (error) throw error;
      if (!data) throw new Error('Client access update returned no persisted row.');
      const persistedClient = data as ClientRecord;
      setClients((prev) => prev.map((client) => (client.id === clientId ? persistedClient : client)));
    } catch (err) {
      console.error('Supabase update client access error:', err);
      showNotification('Unable to save client access details.', 'info');
      return;
    }
    showNotification('Client access details updated.');
  };

  // 2b-2. Invite a client to the Client Portal: creates the placeholder client_portal_users row
  // (auth_id null). The client finishes setup themselves via ClientPortalLogin.tsx's "First Time?"
  // path, which claims this row by matching its own session email — see
  // client_portal_users_claim_rls in the client_portal migration.
  const handleCreatePortalLogin = async (clientId: string, email: string) => {
    const newPortalUserPayload: ClientPortalUserRecord = {
      id: `cpu-${Date.now().toString().slice(-6)}`,
      client_id: clientId,
      auth_id: null,
      email,
      created_at: new Date().toISOString(),
    };

    if (supabaseActive) {
      const { data, error } = await supabase
        .from('client_portal_users')
        .insert([newPortalUserPayload])
        .select();
      if (error) throw error;
      setClientPortalUsers((prev) => [...prev, (data?.[0] as ClientPortalUserRecord) || newPortalUserPayload]);
    } else {
      setClientPortalUsers((prev) => [...prev, newPortalUserPayload]);
    }

    const client = clients.find((c) => c.id === clientId);
    showNotification(`Portal invite sent to ${email} for "${client?.name || clientId}".`);
  };

  // 2c. Mark a client as viewed by its assigned AM Team Lead (clears the "New" indicator)
  const handleMarkClientViewedByAMLead = async (clientId: string) => {
    const viewedAt = new Date().toISOString();

    try {
      await updatePersistedClient(clientId, { am_team_lead_viewed_at: viewedAt });
    } catch (err) {
      console.error('Supabase mark client viewed error:', err);
    }
  };

  // 2d. Mark an assignment as viewed by its assigned agent (Module 12 Phase 5 — clears the
  // "New" indicator for seo_agent/media_buying_agent/social_media_agent)
  const handleMarkAssignmentViewed = async (assignmentId: string) => {
    const viewedAt = new Date().toISOString();

    if (supabaseActive) {
      try {
        const { error } = await supabase
          .from('assignments')
          .update({ viewed_at: viewedAt })
          .eq('id', assignmentId);
        if (error) throw error;
      } catch (err: any) {
        console.error('Supabase mark assignment viewed error:', err);
      }
    }

    setAssignments((prev) =>
      prev.map((a) => (a.id === assignmentId ? { ...a, viewed_at: viewedAt } : a))
    );
  };

  // 2e. Mark a task as viewed by its assignee (Module 12 Phase 5 — same notification concept as
  // handleMarkAssignmentViewed, for programming_agent, which has no assignments row to hang it on)
  const handleMarkTaskViewed = async (taskId: string) => {
    const viewedAt = new Date().toISOString();

    if (supabaseActive) {
      try {
        const { error } = await supabase
          .from('tasks')
          .update({ assignee_viewed_at: viewedAt })
          .eq('id', taskId);
        if (error) throw error;
      } catch (err: any) {
        console.error('Supabase mark task viewed error:', err);
      }
    }

    setTasks((prev) =>
      prev.map((t) => (t.id === taskId ? { ...t, assignee_viewed_at: viewedAt } : t))
    );
  };

  // Assign a service specialist (SEO / Social Media / Media Buying) to a client, by that team's lead
  const handleAssignServiceAgent = async (
    clientId: string,
    serviceType: ServiceType,
    agentId: string,
    reasonNotes?: string
  ) => {
    const existing = assignments.find((a) => a.client_id === clientId && a.service_type === serviceType);
    const assignedUser = users.find((u) => u.id === agentId);
    // A department's own Team Leader can self-assign as the responsible person (see
    // ServiceBriefsRoutingView's eligibleAgents) — in that case team_lead_id should point at
    // them, not their own manager, which manager_id would otherwise resolve to.
    const teamLeadId = isTeamLeadRole(assignedUser?.role) ? agentId : assignedUser?.manager_id || currentUser.id;

    if (existing) {
      // Reassigning to a different agent is a fresh "new client" for them — clears the
      // notification badge so it re-flags as unseen (Module 12 Phase 5).
      const viewedAt = existing.agent_id !== agentId ? null : existing.viewed_at;
      if (supabaseActive) {
        try {
          const { error } = await supabase
            .from('assignments')
            .update({ agent_id: agentId, reason_notes: reasonNotes || existing.reason_notes, viewed_at: viewedAt })
            .eq('id', existing.id);
          if (error) throw error;
        } catch (err: any) {
          console.error('Supabase assignment update error:', err);
        }
      }
      setAssignments((prev) =>
        prev.map((a) =>
          a.id === existing.id
            ? { ...a, agent_id: agentId, reason_notes: reasonNotes || a.reason_notes, viewed_at: viewedAt }
            : a
        )
      );
    } else {
      const newAssignment: AssignmentRecord = {
        id: `asg-${Date.now().toString().slice(-4)}`,
        client_id: clientId,
        service_type: serviceType,
        team_lead_id: teamLeadId,
        agent_id: agentId,
        assigned_at: new Date().toISOString(),
        reason_notes: reasonNotes || null,
      };

      if (supabaseActive) {
        try {
          const { data, error } = await supabase.from('assignments').insert([newAssignment]).select();
          if (error) throw error;
          if (data && data[0]) {
            setAssignments((prev) => [data[0] as AssignmentRecord, ...prev]);
          } else {
            setAssignments((prev) => [newAssignment, ...prev]);
          }
        } catch (err: any) {
          console.error('Supabase assignment insert error:', err);
          setAssignments((prev) => [newAssignment, ...prev]);
        }
      } else {
        setAssignments((prev) => [newAssignment, ...prev]);
      }
    }

    // Persistent notification to the newly-assigned agent — previously missing entirely (only the
    // ephemeral showNotification toast below existed). Fires only on an actual new assignment or a
    // reassignment to a different agent (not a no-op re-save of the same agent), and only once the
    // brief is already submitted — per the confirmed design, assigning before the AM has submitted
    // fires no notification yet, since there's nothing for the agent to view (canViewBriefContent
    // would still hide it from them regardless).
    const isNewOrReassignedAgent = !existing || existing.agent_id !== agentId;
    if (supabaseActive && isNewOrReassignedAgent && assignedUser && isActiveEmployee(assignedUser)) {
      const assignedBrief = briefs.find((b) => b.client_id === clientId && b.service_type === serviceType);
      if (assignedBrief?.submitted_at) {
        try {
          const { error } = await supabaseRaw.from('notifications').insert({
            id: `notif-brief-assigned-${clientId}-${serviceType}-${agentId}-${Date.now()}`,
            user_id: agentId,
            sender_id: currentUser.id,
            title: 'New Service Brief Assignment',
            message: `You have been assigned to handle the ${
              SERVICE_LABELS[serviceType] || serviceType
            } brief for a client. Check your Service Briefs queue.`,
            type: 'general',
            is_read: false,
            link_url: 'module:service_briefs',
            created_at: new Date().toISOString(),
          });
          if (error && error.code !== '23505') throw error;
        } catch (err) {
          console.error('Failed to create brief assignment notification:', err);
        }
      }
    }

    const agent = users.find((u) => u.id === agentId);
    showNotification(`Service brief assigned to specialist: ${agent?.name || agentId}`);
  };

  // 3. Save the dynamic brief form (SEO, Social Media, Media Buying)
  const handleSaveBrief = async (briefData: {
    client_id: string;
    service_type: ServiceType;
    fields: Record<string, any>;
    version: number;
    submitted_by: string;
    custom_field_defs: BriefFieldDef[];
  }) => {
    const existingIndex = briefs.findIndex(
      (b) => b.client_id === briefData.client_id && b.service_type === briefData.service_type
    );

    let updatedBriefs: BriefRecord[] = [];
    let savedBrief: BriefRecord;

    if (existingIndex >= 0) {
      const existing = briefs[existingIndex];
      const updated: BriefRecord = {
        ...existing,
        fields: briefData.fields,
        version: existing.version + 1,
        submitted_by: briefData.submitted_by,
        custom_field_defs: briefData.custom_field_defs,
        // A materially edited brief should re-flag as unread for the relevant Team Lead, even
        // if they'd already seen an earlier version.
        team_lead_viewed_at: null,
        updated_at: new Date().toISOString(),
      };

      if (supabaseActive) {
        try {
          await supabase
            .from('briefs')
            .update({
              fields: updated.fields,
              version: updated.version,
              submitted_by: updated.submitted_by,
              custom_field_defs: updated.custom_field_defs,
              team_lead_viewed_at: updated.team_lead_viewed_at,
              updated_at: updated.updated_at,
            })
            .eq('id', existing.id);
        } catch (err) {
          console.error('Supabase brief update error:', err);
        }
      }

      updatedBriefs = [...briefs];
      updatedBriefs[existingIndex] = updated;
      savedBrief = updated;
    } else {
      const newBrief: BriefRecord = {
        id: `brf-${Date.now().toString().slice(-4)}`,
        client_id: briefData.client_id,
        service_type: briefData.service_type,
        fields: briefData.fields,
        version: 1,
        submitted_by: briefData.submitted_by,
        custom_field_defs: briefData.custom_field_defs,
        team_lead_viewed_at: null,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      };

      if (supabaseActive) {
        try {
          const { data } = await supabase.from('briefs').insert([newBrief]).select();
          if (data && data[0]) {
            newBrief.id = data[0].id;
          }
        } catch (err) {
          console.error('Supabase brief insert error:', err);
        }
      }

      updatedBriefs = [newBrief, ...briefs];
      savedBrief = newBrief;
    }

    setBriefs(updatedBriefs);

    // Append-only revision snapshot — one row per save, including this first one.
    const revision: BriefRevisionRecord = {
      id: `brfrev-${Date.now().toString().slice(-4)}`,
      brief_id: savedBrief.id,
      client_id: savedBrief.client_id,
      service_type: savedBrief.service_type,
      version: savedBrief.version,
      fields: savedBrief.fields,
      edited_by: savedBrief.submitted_by,
      edited_at: savedBrief.updated_at || new Date().toISOString(),
    };

    if (supabaseActive) {
      try {
        const { data } = await supabase.from('brief_revisions').insert([revision]).select();
        if (data && data[0]) {
          revision.id = data[0].id;
        }
      } catch (err) {
        console.error('Supabase brief revision insert error:', err);
      }
    }

    setBriefRevisions((prev) => [revision, ...prev]);
    showNotification('Brief documented and saved as an official version successfully.');
  };

  // 3a-1b. Explicit AM "Submit/Publish Brief" action — separate from handleSaveBrief above, which
  // only ever persists a draft. This is the one-way event that flips briefs.submitted_at, which is
  // what actually unlocks department Team Lead/Agent visibility (canViewBriefContent in
  // lib/permissions.ts, and briefs_select_rls's own "and submitted_at is not null" condition on
  // their branches — the real security boundary this UI action triggers). Left untouched by any
  // later edit to the brief (handleSaveBrief never clears it) — submitting is one-way.
  const handleSubmitBrief = async (briefId: string) => {
    const brief = briefs.find((b) => b.id === briefId);
    if (!brief) return;

    const submittedAt = new Date().toISOString();

    if (supabaseActive) {
      try {
        const { error } = await supabase.from('briefs').update({ submitted_at: submittedAt }).eq('id', briefId);
        if (error) throw error;
      } catch (err) {
        console.error('Supabase brief submit error:', err);
        throw err;
      }
    }

    setBriefs((prev) => prev.map((b) => (b.id === briefId ? { ...b, submitted_at: submittedAt } : b)));
    showNotification('Brief submitted — the relevant Team Leader has been notified.');

    // Notify the relevant department's Team Leader only — reuses the service_type -> team_lead
    // role mapping the renewal-alert effect already established, scoped to this one brief's
    // service_type. Never the agent — that only happens on assignment, see handleAssignServiceAgent.
    const teamLeadRole: UserRole | null =
      brief.service_type === 'seo'
        ? 'seo_team_lead'
        : brief.service_type === 'media_buying'
        ? 'media_buying_team_lead'
        : brief.service_type === 'social_media'
        ? 'social_media_team_lead'
        : null;

    if (teamLeadRole && supabaseActive) {
      const client = clients.find((c) => c.id === brief.client_id);
      const recipients = users.filter((u) => u.role === teamLeadRole && isActiveEmployee(u));
      for (const recipient of recipients) {
        try {
          const { error } = await supabaseRaw.from('notifications').insert({
            id: `notif-brief-submitted-${briefId}-${recipient.id}`,
            user_id: recipient.id,
            sender_id: currentUser.id,
            title: 'Service Brief Submitted',
            message: `The ${SERVICE_LABELS[brief.service_type] || brief.service_type} brief for ${
              client?.name || 'a client'
            } has been submitted and is ready for review.`,
            type: 'general',
            is_read: false,
            link_url: 'module:service_briefs',
            created_at: submittedAt,
          });
          if (error && error.code !== '23505') throw error;
        } catch (err) {
          console.error('Failed to create brief submission notification:', err);
        }
      }
    }
  };

  // 3a-2. Global brief field schema CRUD (point 10) — brief_field_schemas_write_rls scopes who can
  // call these (exec/HoT/am_team_lead/am_agent unconditionally, department team leads scoped to
  // their own service_type). Editing here changes what every NEW brief for that service_type shows
  // going forward; existing submitted briefs' `fields` are untouched.
  const handleCreateBriefFieldSchema = async (
    row: Omit<BriefFieldSchemaRow, 'id' | 'created_at' | 'updated_at'>
  ) => {
    const newRow: BriefFieldSchemaRow = { ...row, id: `bfs-${Date.now().toString().slice(-6)}` };

    if (supabaseActive) {
      try {
        const { data, error } = await supabase.from('brief_field_schemas').insert([newRow]).select();
        if (error) throw error;
        if (data && data[0]) newRow.id = data[0].id;
      } catch (err: any) {
        console.error('Supabase error adding brief field schema:', err);
        showNotification('Unable to add this question.', 'info');
        throw err;
      }
    }

    setBriefFieldSchemaRows((prev) => [...prev, newRow]);
    showNotification('Question added to the global schema.');
  };

  const handleUpdateBriefFieldSchema = async (id: string, updates: Partial<BriefFieldSchemaRow>) => {
    if (supabaseActive) {
      try {
        const { error } = await supabase.from('brief_field_schemas').update(updates).eq('id', id);
        if (error) throw error;
      } catch (err: any) {
        console.error('Supabase error updating brief field schema:', err);
        showNotification('Unable to save this question.', 'info');
        throw err;
      }
    }

    setBriefFieldSchemaRows((prev) => prev.map((r) => (r.id === id ? { ...r, ...updates } : r)));
    showNotification('Question updated.');
  };

  const handleDeleteBriefFieldSchema = async (id: string) => {
    if (supabaseActive) {
      try {
        const { error } = await supabase.from('brief_field_schemas').delete().eq('id', id);
        if (error) throw error;
      } catch (err: any) {
        console.error('Supabase error deleting brief field schema:', err);
        showNotification('Unable to remove this question.', 'info');
        throw err;
      }
    }

    setBriefFieldSchemaRows((prev) => prev.filter((r) => r.id !== id));
    showNotification('Question removed from the global schema.');
  };

  // 3b. Mark a brief as viewed by the relevant service Team Lead (clears its "New" indicator).
  // Routed through the mark_brief_viewed() RPC rather than a direct table update — RLS is
  // row-level, not column-level, so a plain UPDATE policy scoped to "clear this timestamp" can't
  // stop the same caller from writing `fields` too. The RPC re-checks the same
  // role/service_type/client_has_service rule server-side and scopes the write to exactly this
  // one column.
  const handleMarkBriefViewedByTeamLead = async (briefId: string) => {
    if (!supabaseActive) return;
    try {
      const { data, error } = await supabaseRaw.rpc('mark_brief_viewed', { p_brief_id: briefId });
      if (error) throw error;
      const persistedBrief = data as BriefRecord;
      setBriefs((prev) => prev.map((b) => (b.id === briefId ? persistedBrief : b)));
    } catch (err) {
      console.error('Supabase mark brief viewed error:', err);
    }
  };

  // 4. Update the employee's capacity limit
  const handleUpdateUserCapacity = async (userId: string, newLimit: number) => {
    if (supabaseActive) {
      try {
        await supabase
          .from('users')
          .update({ capacity_limit: newLimit })
          .eq('id', userId);
      } catch (err) {
        console.error('Supabase error updating capacity_limit:', err);
      }
    }

    setUsers((prev) =>
      prev.map((u) => (u.id === userId ? { ...u, capacity_limit: newLimit } : u))
    );

    showNotification('Employee capacity limit updated successfully.');
  };

  // Edit an existing employee's name/email/role/team — executive/head_of_technical + all 5 team
  // leads only (RLS's users_update_profile_rls enforces the same scope server-side; this is just
  // the client-side call). Email edits do NOT sync to auth.users automatically here — see the
  // confirmed design: email is only freely editable pre-provisioning; once auth_id is set,
  // changing it here updates the contact-info column only, not the login credential, and should
  // be paired with a separate service-role step if the login email must also change.
  const handleUpdateEmployee = async (
    userId: string,
    updates: { name?: string; email?: string; role?: UserRole; team?: string | null; capacity_limit?: number | null }
  ) => {
    if (supabaseActive) {
      try {
        // supabaseRaw bypasses the legacy client-side users proxy — that proxy's update
        // branch unconditionally mutates the in-memory demo array (or no-ops for a real
        // employee) and always returns error: null, never touching real Postgres.
        const { error } = await supabaseRaw.from('users').update(updates).eq('id', userId);
        if (error) throw error;
      } catch (err: any) {
        console.error('Supabase error updating employee:', err);
        showNotification('Unable to save employee changes.', 'info');
        return;
      }
    }

    setUsers((prev) => prev.map((u) => (u.id === userId ? { ...u, ...updates } : u)));
    showNotification('Employee updated successfully.');
  };

  // Deactivate an employee (permanent, but not a hard delete — the row stays so their name still
  // displays correctly on every historical record). Two effects happen here in the app: their
  // open tasks are unassigned (point 2 — straight to the general unassigned pool, no forced
  // replacement pick) and deactivated_at is set (which every isActiveEmployee() check across the
  // app then excludes them by). The THIRD effect — banning their auth.users account so they can
  // never log in again — happens separately, out-of-band, via
  // `npm run deactivate-auth-users` (scripts/deactivateAuthUser.ts), the same service-role-only
  // pattern as provisioning. That script isn't triggered from here on purpose: it needs the
  // service-role key, which never touches the browser.
  const handleDeactivateEmployee = async (userId: string) => {
    const deactivatedAt = new Date().toISOString();

    if (supabaseActive) {
      try {
        // supabaseRaw bypasses the legacy client-side tasks/users proxies — their update
        // branches unconditionally mutate in-memory demo data (or no-op for real rows) and
        // always return error: null, never touching real Postgres.
        const { error } = await supabaseRaw.from('tasks').update({ assigned_to: null }).eq('assigned_to', userId);
        if (error) throw error;
        const { error: userErr } = await supabaseRaw.from('users').update({ deactivated_at: deactivatedAt }).eq('id', userId);
        if (userErr) throw userErr;
      } catch (err: any) {
        console.error('Supabase error deactivating employee:', err);
        showNotification('Unable to deactivate this employee.', 'info');
        return;
      }
    }

    setTasks((prev) => prev.map((t) => (t.assigned_to === userId ? { ...t, assigned_to: null } : t)));
    setUsers((prev) => prev.map((u) => (u.id === userId ? { ...u, deactivated_at: deactivatedAt } : u)));
    showNotification(
      'Employee deactivated. Run `npm run deactivate-auth-users` to fully lock out their login.'
    );
  };

  // Log a new capacity reading
  const handleLogCapacity = async (newLog: CapacityLogRecord) => {
    if (supabaseActive) {
      try {
        await supabase.from('capacity_logs').insert([newLog]);
      } catch (err) {
        console.error('Supabase capacity_logs insert error:', err);
      }
    }
    setCapacityLogs((prev) => [newLog, ...prev]);
    showNotification('Capacity reading logged successfully.');
  };

  // 5. Update task status on the shared board
  const handleUpdateTaskStatus = async (taskId: string, newStatus: TaskStatus) => {
    const existingTask = tasks.find((t) => t.id === taskId);
    // completed_at is the only reliable signal for "completed today" (the Daily Work Log's
    // auto-suggestion) and for every completion-rate/performance metric in reportingEngine.ts —
    // status alone carries no timing information. Set once when the task first becomes done
    // ('completed' or 'closed'), preserved across a later completed -> closed confirmation
    // (never overwritten or cleared by that transition), and cleared only by a real regression
    // back to a not-done status.
    const completedAt = isTaskDone(newStatus) ? existingTask?.completed_at || new Date().toISOString() : null;
    const updates = { status: newStatus, completed_at: completedAt };

    if (supabaseActive) {
      try {
        await supabase
          .from('tasks')
          .update(updates)
          .eq('id', taskId);
      } catch (err) {
        console.error('Supabase task update error:', err);
      }
    }

    setTasks((prev) =>
      prev.map((t) => (t.id === taskId ? { ...t, ...updates } : t))
    );

    const taskTitle = existingTask?.title || 'Task';
    await logActivity('status_change', 'task', taskId, taskTitle, `Status updated to ${newStatus}`);

    showNotification('Task status moved and the shared board updated.');
  };

  const assertRealTaskClient = async (clientId: string) => {
    if (!clientId) throw new Error('Select a client before saving the task.');
    const { data, error } = await supabaseRaw
      .from('clients')
      .select('id')
      .eq('id', clientId)
      .maybeSingle();
    if (error) throw new Error(`Unable to verify the selected client: ${error.message}`);
    if (!data) throw new Error('The selected client no longer exists in Supabase. Choose an available client.');
  };

  // Update task details and hours
  const handleUpdateTask = async (taskId: string, updates: Partial<TaskRecord>) => {
    const existingTask = tasks.find((t) => t.id === taskId);
    // Same completed_at bookkeeping as handleUpdateTaskStatus above, but only when this edit
    // actually touches status — editing title/description/done_link alone shouldn't disturb it.
    const finalUpdates: Partial<TaskRecord> = { ...updates };
    if ('status' in updates) {
      finalUpdates.completed_at = isTaskDone(updates.status as TaskStatus)
        ? existingTask?.completed_at || new Date().toISOString()
        : null;
    }
    // Reassigning a task to a different person is a fresh "new task" for them (Module 12
    // Phase 5's programming_agent notification badge, since that role has no assignments row).
    if ('assigned_to' in updates) {
      if (existingTask && existingTask.assigned_to !== updates.assigned_to) {
        finalUpdates.assignee_viewed_at = null;
      }
    }

    if (!supabaseActive) throw new Error('Supabase is not configured; the task was not updated.');
    if ('client_id' in finalUpdates) await assertRealTaskClient(finalUpdates.client_id || '');
    let persistedTask: TaskRecord;
    try {
      const { data, error } = await supabaseRaw
        .from('tasks')
        .update(finalUpdates)
        .eq('id', taskId)
        .select('*')
        .single();
      if (error) throw error;
      if (!data) throw new Error('Task update returned no persisted row.');
      persistedTask = data as TaskRecord;
    } catch (err) {
      console.error('Supabase task update error:', err);
      throw err;
    }

    setTasks((prev) => prev.map((t) => (t.id === taskId ? persistedTask : t)));
    
    const taskTitle = tasks.find(t => t.id === taskId)?.title || 'Task';
    await logActivity('update', 'task', taskId, taskTitle, 'Task details updated');

    showNotification('Task data updated successfully.');
  };

  // 6. Add a new shared task (or a subtask, when parent_task_id is set)
  const handleCreateTask = async (taskData: {
    client_id: string;
    title: string;
    description: string;
    assigned_to?: string | null;
    team: string;
    status: TaskStatus;
    due_date: string;
    priority: TaskPriority;
    estimated_hours?: number | null;
    actual_hours?: number | null;
    parent_task_id?: string | null;
  }) => {
    const newTaskPayload: TaskRecord = {
      id: `tsk-${Date.now().toString().slice(-4)}`,
      client_id: taskData.client_id,
      title: taskData.title,
      description: taskData.description,
      assigned_to: taskData.assigned_to || null,
      created_by: currentUser.id,
      team: taskData.team,
      status: taskData.status,
      due_date: taskData.due_date,
      priority: taskData.priority,
      estimated_hours: taskData.estimated_hours ?? 8,
      actual_hours: taskData.actual_hours ?? 0,
      created_at: new Date().toISOString(),
      parent_task_id: taskData.parent_task_id || null,
    };

    if (!supabaseActive) {
      throw new Error('Supabase is not configured; the task was not created.');
    }
    await assertRealTaskClient(newTaskPayload.client_id);

    let persistedTask: TaskRecord;
    try {
      const { data, error } = await supabaseRaw.from('tasks').insert([newTaskPayload]).select();
      if (error) throw error;
      if (!data?.[0]) throw new Error('Task creation returned no persisted row.');
      persistedTask = data[0] as TaskRecord;
    } catch (err) {
      console.error('Supabase task insert error:', err);
      throw err;
    }

    setTasks((prev) => [persistedTask, ...prev]);
    await logActivity('create', 'task', persistedTask.id, persistedTask.title, `Created task for team: ${persistedTask.team}`);

    if (persistedTask.assigned_to) {
      try {
        const { data: recipient, error: recipientError } = await supabaseRaw
          .from('users')
          .select('id, auth_id, deactivated_at')
          .eq('id', persistedTask.assigned_to)
          .maybeSingle();
        if (recipientError) throw recipientError;
        if (recipient && isActiveEmployee(recipient)) {
          const notificationId = `notif-task-created-${persistedTask.id}-${recipient.id}`;
          const { error: notificationError } = await supabaseRaw.from('notifications').insert({
            id: notificationId,
            user_id: recipient.id,
            sender_id: currentUser.id,
            title: 'New Task Assigned',
            message: `You have been assigned a new task: ${persistedTask.title}.`,
            type: 'task_assigned',
            is_read: false,
            link_url: 'module:tasks',
            created_at: persistedTask.created_at || new Date().toISOString(),
          });
          if (notificationError && notificationError.code !== '23505') throw notificationError;
        }
      } catch (err) {
        console.error('Failed to create task notification:', err);
      }
    }

    showNotification(`Task "${taskData.title}" added to the shared task board successfully!`);
  };

  // 6b. Post a task comment or reply (parent_comment_id set for a reply,
  // capped at 3 levels total by a DB trigger)
  const handleAddTaskComment = async (
    taskId: string,
    body: string,
    parentCommentId?: string | null
  ) => {
    const newCommentPayload: TaskCommentRecord = {
      id: `cmt-${Date.now().toString().slice(-4)}`,
      task_id: taskId,
      parent_comment_id: parentCommentId || null,
      author_id: currentUser.id,
      body,
      created_at: new Date().toISOString(),
    };

    if (supabaseActive) {
      try {
        const { data, error } = await supabase
          .from('task_comments')
          .insert([newCommentPayload])
          .select();
        if (error) throw error;
        if (data && data[0]) {
          setTaskComments((prev) => [...prev, data[0] as TaskCommentRecord]);
        } else {
          setTaskComments((prev) => [...prev, newCommentPayload]);
        }
      } catch (err) {
        console.error('Supabase task comment insert error:', err);
        setTaskComments((prev) => [...prev, newCommentPayload]);
      }
    } else {
      setTaskComments((prev) => [...prev, newCommentPayload]);
    }
  };

  // 6c. Edit your own comment's body (sets edited_at)
  const handleEditTaskComment = async (commentId: string, body: string) => {
    const updates: Partial<TaskCommentRecord> = { body, edited_at: new Date().toISOString() };

    if (supabaseActive) {
      try {
        await supabase.from('task_comments').update(updates).eq('id', commentId);
      } catch (err) {
        console.error('Supabase task comment update error:', err);
      }
    }

    setTaskComments((prev) =>
      prev.map((c) => (c.id === commentId ? { ...c, ...updates } : c))
    );
  };

  // 6d. Soft-delete your own comment (sets deleted_at — never a real DELETE,
  // so any replies stay attached to a real row instead of orphaning)
  const handleDeleteTaskComment = async (commentId: string) => {
    const updates: Partial<TaskCommentRecord> = { deleted_at: new Date().toISOString() };

    if (supabaseActive) {
      try {
        await supabase.from('task_comments').update(updates).eq('id', commentId);
      } catch (err) {
        console.error('Supabase task comment delete error:', err);
      }
    }

    setTaskComments((prev) =>
      prev.map((c) => (c.id === commentId ? { ...c, ...updates } : c))
    );
  };

  // 6e. Upload a file attachment to a task. Unlike every other entity in
  // this app, there is no local/demo-mode fallback for this — file bytes
  // can't be represented in the in-memory mock-data system, only a real
  // Supabase Storage bucket can hold them.
  const handleUploadTaskAttachment = async (taskId: string, file: File) => {
    if (!supabaseActive) {
      showNotification('File attachments require a connected Supabase backend.', 'info');
      return;
    }

    const attachmentId = `att-${Date.now().toString().slice(-4)}`;
    const storagePath = buildAttachmentStoragePath(taskId, attachmentId, file.name);

    const { error: uploadError } = await supabase.storage
      .from('task-attachments')
      .upload(storagePath, file, { contentType: file.type });
    if (uploadError) {
      console.error('Supabase attachment upload error:', uploadError);
      throw uploadError;
    }

    const newAttachmentPayload: TaskAttachmentRecord = {
      id: attachmentId,
      task_id: taskId,
      storage_path: storagePath,
      filename: file.name,
      file_size: file.size,
      mime_type: file.type,
      uploaded_by: currentUser.id,
      uploaded_at: new Date().toISOString(),
    };

    const { data, error: insertError } = await supabase
      .from('task_attachments')
      .insert([newAttachmentPayload])
      .select();
    if (insertError) {
      console.error('Supabase attachment metadata insert error:', insertError);
      // The file itself uploaded successfully — clean it up rather than
      // leaving an orphaned Storage object with no matching metadata row.
      await supabase.storage.from('task-attachments').remove([storagePath]);
      throw insertError;
    }

    setTaskAttachments((prev) => [...prev, (data?.[0] as TaskAttachmentRecord) || newAttachmentPayload]);
    showNotification(`"${file.name}" attached successfully.`);
  };

  // 6f. Delete your own attachment — removes both the Storage object and
  // its metadata row (a real delete, not soft: nothing references an
  // attachment as a parent, so there's no orphaning concern like comments
  // have).
  const handleDeleteTaskAttachment = async (attachmentId: string) => {
    const attachment = taskAttachments.find((a) => a.id === attachmentId);
    if (!attachment) return;

    if (supabaseActive) {
      try {
        await supabase.storage.from('task-attachments').remove([attachment.storage_path]);
        await supabase.from('task_attachments').delete().eq('id', attachmentId);
      } catch (err) {
        console.error('Supabase attachment delete error:', err);
      }
    }

    setTaskAttachments((prev) => prev.filter((a) => a.id !== attachmentId));
  };

  // 7. Document a daily activity report (Daily Log)
  const handleCreateDailyLog = async (logData: {
    user_id: string;
    date: string;
    summary_text: string;
    linked_task_ids: string[];
    client_id?: string | null;
  }) => {
    const newLogPayload: DailyLogRecord = {
      id: `log-${Date.now().toString().slice(-4)}`,
      user_id: logData.user_id,
      date: logData.date,
      summary_text: logData.summary_text,
      linked_task_ids: logData.linked_task_ids,
      client_id: logData.client_id ?? null,
      created_at: new Date().toISOString(),
    };

    if (supabaseActive) {
      try {
        const { data, error } = await supabase.from('daily_logs').insert([newLogPayload]).select();
        if (error) throw error;
        if (data && data[0]) {
          setDailyLogs((prev) => [data[0] as DailyLogRecord, ...prev]);
        } else {
          setDailyLogs((prev) => [newLogPayload, ...prev]);
        }
      } catch (err) {
        console.error('Supabase daily_logs insert error:', err);
        setDailyLogs((prev) => [newLogPayload, ...prev]);
      }
    } else {
      setDailyLogs((prev) => [newLogPayload, ...prev]);
    }

    showNotification('Daily activity report logged and saved successfully.');
  };

  // 8. Document an extra note or blocker (Extra Notes)
  const handleCreateExtraNote = async (noteData: {
    user_id: string;
    date: string;
    note_text: string;
    category: string;
  }) => {
    const newNotePayload: ExtraNoteRecord = {
      id: `note-${Date.now().toString().slice(-4)}`,
      user_id: noteData.user_id,
      date: noteData.date,
      note_text: noteData.note_text,
      category: noteData.category,
      created_at: new Date().toISOString(),
    };

    if (supabaseActive) {
      try {
        const { data, error } = await supabase.from('extra_notes').insert([newNotePayload]).select();
        if (error) throw error;
        if (data && data[0]) {
          setExtraNotes((prev) => [data[0] as ExtraNoteRecord, ...prev]);
        } else {
          setExtraNotes((prev) => [newNotePayload, ...prev]);
        }
      } catch (err) {
        console.error('Supabase extra_notes insert error:', err);
        setExtraNotes((prev) => [newNotePayload, ...prev]);
      }
    } else {
      setExtraNotes((prev) => [newNotePayload, ...prev]);
    }
  };

  // 8b. Generate a period-over-period comparison (Reporting Engine) — either a single client, or
  // an agent's pooled client set (that agent's own "all my clients" report, or a team lead
  // generating one for a specific direct report).
  const handleGenerateComparison = async (
    scope: ReportScope,
    mode: ReportMode,
    granularity: ComparisonGranularity | 'custom',
    custom?: { currentRange: DateRange; previousRange?: DateRange }
  ) => {
    let current: ComparisonPeriod;
    let previous: ComparisonPeriod | undefined;

    if (granularity === 'custom' && custom) {
      current = customPeriod(custom.currentRange);
      previous = custom.previousRange ? customPeriod(custom.previousRange) : undefined;
    } else {
      const resolved = resolveComparisonPeriods(granularity as ComparisonGranularity);
      current = resolved.current;
      previous = resolved.previous;
    }

    if (mode === 'comparison' && !previous) return;

    let scopedClients: ClientRecord[];
    let serviceFilter: ServiceType[] | undefined;
    let scopeLabel: string;

    if (scope.type === 'client') {
      const client = clients.find((c) => c.id === scope.clientId);
      if (!client) return;
      scopedClients = [client];
      scopeLabel = client.name;
    } else {
      const subject = users.find((u) => u.id === scope.agentId);
      if (!subject) return;
      scopedClients = resolveClientsForSubject(subject, clients, assignments);
      serviceFilter = serviceFilterForRole(subject.role);
      scopeLabel = subject.name;
    }

    if (scopedClients.length === 0) {
      showNotification('No clients found for this scope — nothing to report on.', 'info');
      return;
    }

    const result =
      mode === 'comparison'
        ? generateClientComparison(scopedClients, current, previous!, campaigns, tasks, socialInsights, serviceFilter)
        : generatePeriodSummary(scopedClients, current, campaigns, tasks, socialInsights, serviceFilter);

    // created_at is preserved from whatever's already in local state (cheap, synchronous) for
    // both write paths below; the network round trip only decides insert-vs-update targeting.
    const localExisting = clientComparisons.find(
      (c) =>
        (scope.type === 'client' ? c.client_id === scope.clientId : c.agent_id === scope.agentId) &&
        c.period_current === result.period_current &&
        c.period_previous === result.period_previous
    );

    const comparisonPayload: ClientComparisonRecord = {
      id: localExisting?.id || `cmp-${Date.now().toString().slice(-4)}`,
      ...result,
      client_id: scope.type === 'client' ? scope.clientId : null,
      agent_id: scope.type === 'agent' ? scope.agentId : null,
      covered_client_ids: scope.type === 'client' ? null : result.covered_client_ids,
      created_at: localExisting?.created_at || new Date().toISOString(),
    };

    // Only the client-scoped comparison case sits behind the original, non-partial unique
    // constraint (client_id, period_current, period_previous) — PostgREST's upsert(onConflict)
    // can target that in one round trip. Every other combination (agent-scoped, or any
    // period_summary row) sits behind a partial unique index instead (added across the last two
    // migrations), which Postgres's ON CONFLICT arbiter inference generally won't match via a
    // bare column list — those look up any existing row explicitly first, then update or insert.
    const canOneShotUpsert = scope.type === 'client' && mode === 'comparison';

    if (supabaseActive) {
      try {
        let data: ClientComparisonRecord[] | null;
        let error: unknown;

        if (canOneShotUpsert) {
          ({ data, error } = await supabase
            .from('client_comparisons')
            .upsert([comparisonPayload], { onConflict: 'client_id,period_current,period_previous' })
            .select());
        } else {
          let lookup = supabase.from('client_comparisons').select('id').eq('period_current', result.period_current);
          lookup = scope.type === 'client' ? lookup.eq('client_id', scope.clientId) : lookup.eq('agent_id', scope.agentId);
          lookup = result.period_previous === null ? lookup.is('period_previous', null) : lookup.eq('period_previous', result.period_previous);
          const { data: existingRow, error: lookupError } = await lookup.maybeSingle();
          if (lookupError) throw lookupError;

          ({ data, error } = existingRow
            ? await supabase.from('client_comparisons').update(comparisonPayload).eq('id', existingRow.id).select()
            : await supabase.from('client_comparisons').insert([comparisonPayload]).select());
        }

        if (error) throw error;
        const saved = data?.[0] || comparisonPayload;
        setClientComparisons((prev) => [...prev.filter((c) => c.id !== saved.id), saved]);
      } catch (err) {
        console.error('Supabase client_comparisons write error:', err);
        showNotification('Unable to save the report.', 'info');
        return;
      }
    } else {
      setClientComparisons((prev) => [...prev.filter((c) => c.id !== comparisonPayload.id), comparisonPayload]);
    }

    const periodLabel = mode === 'comparison' ? `${result.period_current} vs ${result.period_previous}` : result.period_current;
    const kindLabel = mode === 'comparison' ? 'Comparison' : 'Period report';
    showNotification(`${kindLabel} generated for ${scopeLabel} (${periodLabel}).`);
  };

  // 8c. File a monthly/period report against an existing comparison (Reporting Engine). The
  // report's scope always follows its comparison via comparison_id — client_id here is purely a
  // display convenience, denormalized from the comparison at filing time.
  const handleGenerateReport = async (comparisonId: string, period: string) => {
    const comparison = clientComparisons.find((c) => c.id === comparisonId);

    const reportPayload: ReportRecord = {
      id: `rpt-${Date.now().toString().slice(-4)}`,
      client_id: comparison?.client_id ?? null,
      type: 'internal',
      period,
      generated_by: currentUser.id,
      comparison_id: comparisonId,
      status: 'final',
      created_at: new Date().toISOString(),
    };

    if (supabaseActive) {
      try {
        const { data, error } = await supabase.from('reports').insert([reportPayload]).select();
        if (error) throw error;
        const saved = (data?.[0] as ReportRecord) || reportPayload;
        setReports((prev) => [...prev, saved]);
      } catch (err) {
        console.error('Supabase reports insert error:', err);
        showNotification('Unable to file the report.', 'info');
        return;
      }
    } else {
      setReports((prev) => [...prev, reportPayload]);
    }

    showNotification(`Report filed for ${period}.`);
  };

  // 8d. Generate (or regenerate) a client's monthly report draft (Module 9, point 4): a period
  // summary comparison plus a `reports` row in 'draft' status pointing at it. Deliberately not
  // routed through handleGenerateComparison — that function's upsert/agent-scope branching
  // doesn't apply here (this is always client-scoped, always a period_summary), so the always-
  // single-client case is simpler to write directly. type is 'client' (not 'internal', like every
  // other report filed today) since a monthly report draft is, by nature, meant to become a
  // client-facing document once approved.
  const handleGenerateMonthlyReportDraft = async (clientId: string) => {
    const client = clients.find((c) => c.id === clientId);
    if (!client) return;

    const period = resolveComparisonPeriods('monthly').current;
    const result = generatePeriodSummary([client], period, campaigns, tasks, socialInsights);

    const localExistingComparison = clientComparisons.find(
      (c) => c.client_id === clientId && c.row_kind === 'period_summary' && c.period_current === result.period_current
    );
    const comparisonPayload: ClientComparisonRecord = {
      id: localExistingComparison?.id || `cmp-${Date.now().toString().slice(-4)}`,
      ...result,
      client_id: clientId,
      agent_id: null,
      covered_client_ids: null,
      created_at: localExistingComparison?.created_at || new Date().toISOString(),
    };

    let savedComparison: ClientComparisonRecord = comparisonPayload;

    if (supabaseActive) {
      try {
        const { data, error } = localExistingComparison
          ? await supabase.from('client_comparisons').update(comparisonPayload).eq('id', localExistingComparison.id).select()
          : await supabase.from('client_comparisons').insert([comparisonPayload]).select();
        if (error) throw error;
        savedComparison = (data?.[0] as ClientComparisonRecord) || comparisonPayload;
        setClientComparisons((prev) => [...prev.filter((c) => c.id !== savedComparison.id), savedComparison]);
      } catch (err) {
        console.error('Supabase client_comparisons write error:', err);
        showNotification('Unable to generate the monthly report draft.', 'info');
        return;
      }
    } else {
      setClientComparisons((prev) => [...prev.filter((c) => c.id !== comparisonPayload.id), comparisonPayload]);
    }

    // Reuse an existing draft report for this exact comparison if one already exists (so
    // regenerating a draft updates it in place rather than accumulating duplicate report rows).
    const existingDraftReport = reports.find((r) => r.comparison_id === savedComparison.id && r.status === 'draft');

    const reportPayload: ReportRecord = {
      id: existingDraftReport?.id || `rpt-${Date.now().toString().slice(-4)}`,
      client_id: clientId,
      type: 'client',
      period: result.period_current,
      generated_by: currentUser.id,
      comparison_id: savedComparison.id,
      status: 'draft',
      created_at: existingDraftReport?.created_at || new Date().toISOString(),
    };

    if (supabaseActive) {
      try {
        const { data, error } = existingDraftReport
          ? await supabase.from('reports').update(reportPayload).eq('id', existingDraftReport.id).select()
          : await supabase.from('reports').insert([reportPayload]).select();
        if (error) throw error;
        const saved = (data?.[0] as ReportRecord) || reportPayload;
        setReports((prev) => [...prev.filter((r) => r.id !== saved.id), saved]);
      } catch (err) {
        console.error('Supabase reports insert error:', err);
        showNotification('Unable to save the monthly report draft.', 'info');
        return;
      }
    } else {
      setReports((prev) => [...prev.filter((r) => r.id !== reportPayload.id), reportPayload]);
    }

    showNotification(`Monthly report draft generated for ${client.name} (${result.period_current}).`);
  };

  // 8e. Approve a draft report, marking it final and attributing the approval.
  const handleApproveReport = async (reportId: string) => {
    const updates: Partial<ReportRecord> = {
      status: 'final',
      approved_by: currentUser.id,
      approved_at: new Date().toISOString(),
    };

    if (supabaseActive) {
      try {
        const { error } = await supabase.from('reports').update(updates).eq('id', reportId);
        if (error) throw error;
      } catch (err) {
        console.error('Supabase report approve error:', err);
        showNotification('Unable to approve the report.', 'info');
        return;
      }
    }

    setReports((prev) => prev.map((r) => (r.id === reportId ? { ...r, ...updates } : r)));
    showNotification('Report approved and marked final.');
  };

  // 8f. Upload a meeting recording (Module 9 scaffolding, point 5). Unlike every other entity in
  // this app, there is no local/demo-mode fallback for the file itself — same reasoning as
  // handleUploadTaskAttachment: file bytes can't be represented in the in-memory mock-data
  // system, only a real Supabase Storage bucket can hold them. transcript_text/ai_summary_text
  // start empty — there is no real transcription/summarization yet, they're filled in manually
  // afterward via handleSaveMeetingNotes.
  const handleUploadMeetingRecording = async (clientId: string, meetingDate: string, file: File) => {
    if (!supabaseActive) {
      showNotification('Meeting recordings require a connected Supabase backend.', 'info');
      return;
    }

    const client = clients.find((c) => c.id === clientId);
    const meetingId = `mtg-${Date.now().toString().slice(-4)}`;
    const storagePath = buildMeetingRecordingStoragePath(clientId, meetingId, file.name);

    const { error: uploadError } = await supabase.storage
      .from('meeting-recordings')
      .upload(storagePath, file, { contentType: file.type });
    if (uploadError) {
      console.error('Supabase meeting recording upload error:', uploadError);
      throw uploadError;
    }

    const newMeetingPayload: MeetingRecord = {
      id: meetingId,
      client_id: clientId,
      am_agent_id: client?.am_agent_id || currentUser.id,
      meeting_date: meetingDate,
      recording_url: storagePath,
      transcript_text: null,
      ai_summary_text: null,
      created_at: new Date().toISOString(),
    };

    const { data, error: insertError } = await supabase.from('meetings').insert([newMeetingPayload]).select();
    if (insertError) {
      console.error('Supabase meetings insert error:', insertError);
      // The file itself uploaded successfully — clean it up rather than leaving an orphaned
      // Storage object with no matching metadata row.
      await supabase.storage.from('meeting-recordings').remove([storagePath]);
      throw insertError;
    }

    setMeetings((prev) => [...prev, (data?.[0] as MeetingRecord) || newMeetingPayload]);
    showNotification('Meeting recording uploaded successfully.');
  };

  // 8g. Save manually-entered transcript/summary notes for a meeting (Module 9 scaffolding) —
  // plain text today, not a model call.
  const handleSaveMeetingNotes = async (
    meetingId: string,
    updates: { transcript_text?: string; ai_summary_text?: string }
  ) => {
    if (supabaseActive) {
      try {
        const { error } = await supabase.from('meetings').update(updates).eq('id', meetingId);
        if (error) throw error;
      } catch (err) {
        console.error('Supabase meeting notes update error:', err);
        showNotification('Unable to save meeting notes.', 'info');
        return;
      }
    }

    setMeetings((prev) => prev.map((m) => (m.id === meetingId ? { ...m, ...updates } : m)));
    showNotification('Meeting notes saved.');
  };

  // 8g. Upload a signed contract document for a client (Module 12 Phase 6) — same private-bucket
  // upload-then-insert-metadata pattern as handleUploadMeetingRecording/handleUploadTaskAttachment.
  const handleUploadClientContract = async (clientId: string, file: File) => {
    if (!supabaseActive) {
      showNotification('Contract uploads require a connected Supabase backend.', 'info');
      return;
    }

    const contractId = `ctr-${Date.now().toString().slice(-4)}`;
    const storagePath = buildClientContractStoragePath(clientId, contractId, file.name);

    const { error: uploadError } = await supabase.storage
      .from('client-contracts')
      .upload(storagePath, file, { contentType: file.type });
    if (uploadError) {
      console.error('Supabase contract upload error:', uploadError);
      throw uploadError;
    }

    const newContractPayload: ClientContractRecord = {
      id: contractId,
      client_id: clientId,
      storage_path: storagePath,
      filename: file.name,
      file_size: file.size,
      mime_type: file.type,
      uploaded_by: currentUser.id,
      uploaded_at: new Date().toISOString(),
    };

    const { data, error: insertError } = await supabase
      .from('client_contracts')
      .insert([newContractPayload])
      .select();
    if (insertError) {
      console.error('Supabase contract metadata insert error:', insertError);
      // The file itself uploaded successfully — clean it up rather than leaving an orphaned
      // Storage object with no matching metadata row.
      await supabase.storage.from('client-contracts').remove([storagePath]);
      throw insertError;
    }

    setClientContracts((prev) => [...prev, (data?.[0] as ClientContractRecord) || newContractPayload]);
    showNotification(`"${file.name}" uploaded successfully.`);
  };

  // Delete your own contract upload — removes both the Storage object and its metadata row.
  const handleDeleteClientContract = async (contractId: string) => {
    const contract = clientContracts.find((c) => c.id === contractId);
    if (!contract) return;

    if (supabaseActive) {
      try {
        await supabase.storage.from('client-contracts').remove([contract.storage_path]);
        await supabase.from('client_contracts').delete().eq('id', contractId);
      } catch (err) {
        console.error('Supabase contract delete error:', err);
      }
    }

    setClientContracts((prev) => prev.filter((c) => c.id !== contractId));
    showNotification('Contract document removed.');
  };

  // 8h. Manually set a platform's connection status (Module 6 scaffolding, point 1). This is a
  // real tracker of the human process of getting API access from a client — never a live
  // connection, never a real OAuth flow, and no credentials are read or written here at all.
  const handleSetPlatformConnectionStatus = async (
    clientId: string,
    platformName: string,
    platformCategory: PlatformCategory,
    status: PlatformConnectionStatus,
    notes: string
  ) => {
    const existing = platformConnections.find((p) => p.client_id === clientId && p.platform_name === platformName);
    const now = new Date().toISOString();
    const payload: PlatformConnectionRecord = {
      id: existing?.id || `pc-${Date.now().toString().slice(-4)}`,
      client_id: clientId,
      platform_category: platformCategory,
      platform_name: platformName,
      status,
      connected_by: currentUser.id,
      connected_at: now,
      last_synced_at: existing?.last_synced_at || null,
      notes: notes || null,
      created_at: existing?.created_at || now,
      updated_at: now,
    };

    if (supabaseActive) {
      try {
        const { error } = await supabase.from('platform_connections').upsert([payload], { onConflict: 'client_id,platform_name' });
        if (error) throw error;
      } catch (err) {
        console.error('Supabase platform_connections upsert error:', err);
        showNotification('Unable to update the connection status.', 'info');
        return;
      }
    }

    setPlatformConnections((prev) => [...prev.filter((p) => p.id !== payload.id), payload]);
    showNotification(`${platformName.replace(/_/g, ' ')} marked as ${status.replace('_', ' ')}.`);
  };

  // 9. Create and update ad campaigns (Campaign Management)
  const handleCreateCampaign = async (campaignData: Partial<CampaignRecord>) => {
    const newId = `cmp-${Date.now().toString().slice(-4)}`;
    const newRecord: CampaignRecord = {
      id: newId,
      client_id: campaignData.client_id || '',
      name: campaignData.name || 'Sponsored Ad Campaign',
      platform: campaignData.platform || 'meta',
      campaign_id_external: campaignData.campaign_id_external || null,
      objective: campaignData.objective || 'Conversions & Sales',
      status: campaignData.status || 'active',
      budget: campaignData.budget || 0,
      spend: campaignData.spend || 0,
      start_date: campaignData.start_date || new Date().toISOString().split('T')[0],
      end_date: campaignData.end_date || null,
      owner_id: campaignData.owner_id || currentUser.id,
      team: campaignData.team || 'Media Buying',
      date: campaignData.date || new Date().toISOString().split('T')[0],
      results: campaignData.results || {},
      created_at: new Date().toISOString(),
    };

    if (supabaseActive) {
      try {
        const { data, error } = await supabase.from('campaigns').insert([newRecord]).select();
        if (error) throw error;
        if (data && data[0]) {
          setCampaigns((prev) => [data[0] as CampaignRecord, ...prev]);
        } else {
          setCampaigns((prev) => [newRecord, ...prev]);
        }
      } catch (err: any) {
        console.warn('Supabase campaign insert fallback to state:', err);
        setCampaigns((prev) => [newRecord, ...prev]);
      }
    } else {
      setCampaigns((prev) => [newRecord, ...prev]);
    }

    showNotification(`Campaign "${newRecord.name}" created and activated successfully!`);
  };

  const handleUpdateCampaign = async (id: string, updates: Partial<CampaignRecord>) => {
    if (supabaseActive) {
      try {
        const { error } = await supabase.from('campaigns').update(updates).eq('id', id);
        if (error) throw error;
      } catch (err: any) {
        console.warn('Supabase campaign update fallback to state:', err);
      }
    }

    setCampaigns((prev) =>
      prev.map((c) => (c.id === id ? { ...c, ...updates, results: { ...(c.results || {}), ...(updates.results || {}) } } : c))
    );

    showNotification('Campaign data updated successfully.');
  };

  // Stats for badge counters
  const activeTasksCount = tasks.filter((t) => !isTaskDone(t.status)).length;
  const onboardingClientsCount = clients.filter((c) => c.status === 'onboarding').length;
  const blockedTasksCount = tasks.filter((t) => t.status === 'blocked').length;

  // MiniChat send: insert a real row via supabaseRaw first, only append locally on success —
  // same "persist, then sync local state" pattern as handleUpdateEmployee/
  // MiniChat send: insert a real row via supabaseRaw first, only append locally on success —
  // same "persist, then sync local state" pattern as handleUpdateEmployee/
  // handleDeactivateEmployee. Not appending optimistically-then-rolling-back on failure avoids
  // ever showing a message that didn't actually reach the other person.
  const handleSendChatMessage = async (
    receiverId: string, 
    content: string, 
    replyToId?: string,
    attachmentUrl?: string,
    attachmentName?: string,
    attachmentType?: string
  ): Promise<boolean> => {
    const newMsg: any = {
      id: `msg-${Date.now()}`,
      sender_id: currentUser.id,
      receiver_id: receiverId,
      content,
      is_read: false,
      reply_to_id: replyToId,
      created_at: new Date().toISOString(),
    };
    
    if (attachmentUrl) newMsg.attachment_url = attachmentUrl;
    if (attachmentName) newMsg.attachment_name = attachmentName;
    if (attachmentType) newMsg.attachment_type = attachmentType;
    if (supabaseActive) {
      try {
        const { error } = await supabaseRaw.from('chat_messages').insert(newMsg);
        if (error) throw error;
      } catch (err: any) {
        console.error('Failed to send chat message:', err);
        window.alert(`DB Insert Error: ${err.message || JSON.stringify(err)}`);
        showNotification('Unable to send message.', 'info');
        return false;
      }
    }
    setChatMessages((prev) => [...prev, newMsg]);
    return true;
  };

  const handleUploadChatAttachment = async (file: File): Promise<{ url: string; name: string; type: string } | null> => {
    if (!supabaseActive) {
      showNotification('Chat attachments require a connected Supabase backend.', 'info');
      return null;
    }
    
    // Ensure the folder structure organizes by sender ID and date to avoid collisions
    const folderDate = new Date().toISOString().split('T')[0];
    const timestamp = Date.now();
    const safeName = file.name.replace(/[^a-zA-Z0-9.-]/g, '_');
    const storagePath = `${currentUser.id}/${folderDate}/${timestamp}_${safeName}`;

    try {
      const { error: uploadError } = await supabaseRaw.storage
        .from('chat-attachments')
        .upload(storagePath, file, { contentType: file.type });
        
      if (uploadError) {
        console.error('Supabase chat attachment upload error:', uploadError);
        throw uploadError;
      }
      
      const { data } = supabaseRaw.storage.from('chat-attachments').getPublicUrl(storagePath);
      
      return {
        url: data.publicUrl,
        name: file.name,
        type: file.type.startsWith('image/') ? 'image' : 'file'
      };
    } catch (err: any) {
      console.error('Failed to upload chat attachment:', err);
      window.alert(`Upload Error: ${err.message || JSON.stringify(err)}`);
      showNotification('Failed to upload attachment.', 'info');
      return null;
    }
  };

  const handleEditChatMessage = async (messageId: string, content: string): Promise<boolean> => {
    const message = chatMessages.find((item) => item.id === messageId);
    const trimmedContent = content.trim();
    if (!message || message.sender_id !== currentUser.id || !trimmedContent) return false;
    if (message.content === trimmedContent) return true;

    if (supabaseActive) {
      try {
        const { error } = await supabaseRaw
          .from('chat_messages')
          .update({ content: trimmedContent })
          .eq('id', messageId);
        if (error) throw error;
      } catch (err) {
        console.error('Failed to edit chat message:', err);
        showNotification('Unable to edit message.', 'info');
        return false;
      }
    }

    setChatMessages((prev) =>
      prev.map((item) => (item.id === messageId ? { ...item, content: trimmedContent } : item))
    );
    return true;
  };

  const handleDeleteChatMessage = async (messageId: string): Promise<boolean> => {
    const message = chatMessages.find((item) => item.id === messageId);
    if (!message || message.sender_id !== currentUser.id) return false;

    if (supabaseActive) {
      try {
        const { error } = await supabaseRaw.from('chat_messages').delete().eq('id', messageId);
        if (error) throw error;
      } catch (err) {
        console.error('Failed to delete chat message:', err);
        showNotification('Unable to delete message.', 'info');
        return false;
      }
    }

    setChatMessages((prev) => prev.filter((item) => item.id !== messageId));
    return true;
  };

  const handleClearChatConversation = async (otherUserId: string): Promise<boolean> => {
    const clearRecord: ChatConversationClearRecord = {
      user_id: currentUser.id,
      other_user_id: otherUserId,
      cleared_at: new Date().toISOString(),
    };

    if (supabaseActive) {
      try {
        const { data, error } = await supabaseRaw
          .from('chat_conversation_clears')
          .upsert(clearRecord, { onConflict: 'user_id,other_user_id' })
          .select()
          .single();
        if (error) throw error;
        if (data) Object.assign(clearRecord, data as ChatConversationClearRecord);
      } catch (err) {
        console.error('Failed to clear chat conversation:', err);
        showNotification('Unable to clear conversation.', 'info');
        return false;
      }
    }

    setChatConversationClears((prev) => [
      ...prev.filter(
        (item) => item.user_id !== currentUser.id || item.other_user_id !== otherUserId
      ),
      clearRecord,
    ]);

    const conversationLink = `chat:${otherUserId}`;
    setNotifications((prev) => {
      prev.forEach((notification) => {
        if (
          notification.user_id === currentUser.id &&
          !notification.is_read &&
          notification.link_url === conversationLink
        ) {
          locallyReadNotificationIds.current.add(notification.id);
        }
      });
      return prev.map((notification) =>
        notification.user_id === currentUser.id &&
        !notification.is_read &&
        notification.link_url === conversationLink
          ? { ...notification, is_read: true }
          : notification
      );
    });
    if (supabaseActive) {
      supabaseRaw
        .from('notifications')
        .update({ is_read: true })
        .eq('user_id', currentUser.id)
        .eq('is_read', false)
        .eq('link_url', conversationLink)
        .then(({ error }) => {
          if (error) console.error('Failed to dismiss cleared-conversation notifications:', error);
        });
    }
    return true;
  };

  // MiniChat conversation open: mark that thread's unread messages (where I'm the receiver)
  // read — matches chat_messages_update_rls's receiver_id = app_user_id() exactly.
  const handleOpenChatConversation = async (otherUserId: string) => {
    const clearedAt = chatConversationClears.find(
      (item) => item.user_id === currentUser.id && item.other_user_id === otherUserId
    )?.cleared_at;
    const unreadIds = chatMessages
      .filter(
        (m) =>
          m.sender_id === otherUserId &&
          m.receiver_id === currentUser.id &&
          !m.is_read &&
          (!clearedAt || new Date(m.created_at).getTime() > new Date(clearedAt).getTime())
      )
      .map((m) => m.id);
    const conversationLink = `chat:${otherUserId}`;
    const hasUnreadChatNotifications = notifications.some(
      (notification) =>
        notification.user_id === currentUser.id &&
        !notification.is_read &&
        notification.link_url === conversationLink
      );

    // The notification trigger writes notif-chat-<message-id> atomically with the message.
    // Recording these IDs before its Realtime INSERT arrives preserves this acknowledgement even
    // if that INSERT payload is delivered after the notification UPDATE.
    unreadIds.forEach((messageId) => locallyReadNotificationIds.current.add(`notif-chat-${messageId}`));

    if (hasUnreadChatNotifications || unreadIds.length > 0) {
      setNotifications((prev) => {
        prev.forEach((notification) => {
          if (
            notification.user_id === currentUser.id &&
            !notification.is_read &&
            notification.link_url === conversationLink
          ) {
            locallyReadNotificationIds.current.add(notification.id);
          }
        });
        return prev.map((notification) =>
          notification.user_id === currentUser.id &&
          !notification.is_read &&
          notification.link_url === conversationLink
            ? { ...notification, is_read: true }
            : notification
        );
      });
      if (supabaseActive) {
        supabaseRaw
          .from('notifications')
          .update({ is_read: true })
          .eq('user_id', currentUser.id)
          .eq('is_read', false)
          .eq('link_url', conversationLink)
          .then(({ error }) => {
            if (error) console.error('Failed to persist chat notification read status:', error);
          });
      }
    }

    if (unreadIds.length === 0) return;

    if (supabaseActive) {
      try {
        const { error } = await supabaseRaw.from('chat_messages').update({ is_read: true }).in('id', unreadIds);
        if (error) throw error;
      } catch (err: any) {
        console.error('Failed to mark chat messages as read:', err);
        return;
      }
    }
    setChatMessages((prev) =>
      prev.map((m) => (unreadIds.includes(m.id) ? { ...m, is_read: true } : m))
    );
  };

  // A PASSWORD_RECOVERY session takes precedence over everything else below
  // — including an already-authenticatedUser, which shouldn't be possible
  // at the same time, but this ordering keeps that invariant explicit
  // rather than relied upon.
  if (isPasswordRecovery) {
    return <SetPasswordScreen onComplete={handlePasswordRecoveryComplete} />;
  }

  // If no authenticated employee, render the dedicated Employee Portal Login
  if (!authenticatedUser) {
    return (
      <>
        {testHandoff && (
          <div className="fixed inset-x-0 top-0 z-50 flex flex-wrap items-center justify-between gap-2 border-b border-amber-500 bg-amber-950 px-4 py-3 text-sm text-amber-100">
            <span>TESTING LOGIN — Sign in normally with the employee's Auth email: <strong>{testHandoff.email}</strong></span>
            <button onClick={() => { sessionStorage.removeItem(TEST_SESSION_KEY); setTestHandoff(null); }}
              className="rounded-lg border border-amber-400 px-3 py-1">Return to Admin Login</button>
          </div>
        )}
        <EmployeeLogin
          key={testHandoff?.authId || 'normal-login'}
          users={users}
          onLoginSuccess={handleLoginSuccess}
          supabaseActive={supabaseActive}
          realTestEmail={testHandoff?.email}
        />
      </>
    );
  }

  return (
    <div className="min-h-screen pb-16" dir="ltr" style={{ background: 'var(--gradient-page)', color: 'var(--lilac)' }}>
      {/* Top Navigation Bar adhering to Kesra Brand Identity */}
      <header
        className="sticky top-0 z-40 backdrop-blur-md px-6 py-3.5 border-b"
        style={{
          background: 'var(--header-surface)',
          borderColor: 'var(--nav-border)',
        }}
      >
        <div className="max-w-screen-2xl mx-auto flex flex-wrap items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            <button
              onClick={() => setIsMobileSidebarOpen(true)}
              className="md:hidden p-2 -ml-1 rounded-lg transition-colors shrink-0"
              style={{ background: 'var(--control-surface)', border: '1px solid var(--border-soft)', color: 'var(--text-mid)' }}
              title="Open navigation menu"
              aria-label="Open navigation menu"
            >
              <Menu className="w-4 h-4" />
            </button>
            <div
              className="w-10 h-10 rounded-[12px] flex items-center justify-center shadow-lg font-bold text-lg"
              style={{
                background: 'var(--gradient-badge)',
                border: '1px solid var(--border-strong)',
                color: 'var(--on-accent)',
              }}
            >
              K
            </div>
            <div>
              <div className="flex items-center gap-2">
                <h1
                  className="text-lg font-bold tracking-tight"
                  style={{
                    background: 'var(--gradient-title-text)',
                    WebkitBackgroundClip: 'text',
                    WebkitTextFillColor: 'transparent',
                  }}
                >
                  Kesra Management System
                </h1>
                <span
                  className="text-[10px] px-2 py-0.5 rounded-full font-bold uppercase tracking-wider"
                  style={{
                    background: 'rgba(123, 47, 247, 0.25)',
                    color: 'var(--purple-light)',
                    border: '1px solid var(--border-soft)',
                  }}
                >
                  Operational System
                </span>
              </div>
            </div>
          </div>

          <div className="flex flex-wrap items-center justify-end gap-3">
            {canAccessTestingMode && usersLoadedFromSupabase && (
              <button
                onClick={() => setIsTestingSelectorOpen(true)}
                className="employee-testing-action hidden md:block rounded-xl border border-amber-600/60 bg-amber-950/40 px-3 py-2 text-xs font-bold text-amber-200 hover:bg-amber-900/60"
              >
                Employee Testing Mode
              </button>
            )}
            {/* TEMPORARY TRANSITION FEATURE — see the constants near the top of this file. */}
            {canAccessImpersonation && usersLoadedFromSupabase && (
              <button
                onClick={() => setIsImpersonationSelectorOpen(true)}
                className="employee-impersonation-action hidden md:block rounded-xl border border-red-600/60 bg-red-950/40 px-3 py-2 text-xs font-bold text-red-200 hover:bg-red-900/60"
                title="Temporary transition tool — log in as an employee without their password"
              >
                Impersonate Employee
              </button>
            )}
            {/* زر النشاط الحي للمديرين — hidden below md: a desk-admin convenience, not essential mobile nav */}
            {['executive', 'head_of_technical', 'ai_engineer'].includes(currentUser.role) && (
              <button
                onClick={() => setIsActivityFeedOpen(!isActivityFeedOpen)}
                className="hidden md:flex text-xs px-4 py-2 rounded-xl font-bold items-center gap-2 transition-all shadow-lg hover:shadow-purple-500/20 hover:-translate-y-0.5 active:translate-y-0 text-white"
                style={{ background: 'var(--gradient-badge)', border: '1px solid var(--border-strong)' }}
              >
                <div className="w-2 h-2 rounded-full bg-emerald-300 animate-pulse border border-emerald-500" />
                Live Activity Feed ⚡
              </button>
            )}

            {/* Light/Dark Theme Toggle */}
            <button
              onClick={toggleTheme}
              className="p-1.5 rounded-lg transition-colors shrink-0"
              style={{ background: 'var(--control-surface)', border: '1px solid var(--border-soft)', color: 'var(--text-mid)' }}
              title={theme === 'light' ? 'Switch to dark mode' : 'Switch to light mode'}
              aria-label={theme === 'light' ? 'Switch to dark mode' : 'Switch to light mode'}
            >
              {theme === 'light' ? <Moon className="w-3.5 h-3.5" /> : <Sun className="w-3.5 h-3.5" />}
            </button>

            {/* Notification Bell */}
            <NotificationBell
              notifications={notifications.filter(n => n.user_id === currentUser.id)}
              users={users}
              onMarkAsRead={handleMarkNotificationAsRead}
              onMarkAllAsRead={handleMarkAllNotificationsAsRead}
              onNotificationClick={handleNotificationClick}
            />

            {/* Online Users Widget — hidden below md, not essential mobile nav */}
            <div className="hidden md:block">
              <OnlineUsersWidget users={users} tasks={tasks} clients={clients} onlineUserIds={onlineUserIds} />
            </div>

            {/* Supabase Status Indicator — hidden below md, decorative connection info */}
            <div
              className="hidden md:flex items-center gap-2 px-3 py-1.5 rounded-xl text-xs"
              style={{
                background: 'var(--control-surface)',
                border: '1px solid var(--border-soft)',
              }}
              title={supabaseActive ? 'Connected to Supabase - RLS Active' : 'Supabase RLS Ready'}
            >
              <div
                className="w-2 h-2 rounded-full animate-pulse"
                style={{ background: supabaseActive ? 'var(--roas-good)' : 'var(--roas-mid)' }}
              />
              <span style={{ color: supabaseActive ? 'var(--roas-good)' : 'var(--roas-mid)' }}>
                {supabaseActive ? 'Supabase Connected (RLS Active)' : 'Supabase Configured'}
              </span>
            </div>


            {/* Global Refresh (moved here from the old nav bar — refreshes every module's data) */}
            <button
              onClick={loadData}
              className="p-1.5 rounded-lg transition-colors shrink-0"
              style={{ background: 'var(--control-surface)', border: '1px solid var(--border-soft)', color: 'var(--text-mid)' }}
              title="Refresh data"
            >
              <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} />
            </button>

            {/* Authenticated Employee Badge & Portal Indicator */}
            <div
              className="flex items-center gap-2.5 px-3 py-1.5 rounded-xl border backdrop-blur-md shadow-sm"
              style={{
                background: 'var(--control-surface)',
                borderColor: 'var(--border-soft)',
              }}
            >
              <div
                className="w-7 h-7 rounded-lg flex items-center justify-center font-bold text-xs shadow-inner"
                style={{ background: userRoleInfo.badgeBg, color: userRoleInfo.badgeText }}
              >
                {currentUser.name.charAt(0)}
              </div>
              <div className="flex flex-col text-left">
                <div className="text-xs font-bold flex items-center gap-1.5" style={{ color: 'var(--text-hi)' }}>
                  <span>{currentUser.name}</span>
                  <span
                    className="hidden sm:inline-block px-1.5 py-0.2 rounded text-[10px] font-semibold"
                    style={{ background: userRoleInfo.badgeBg, color: userRoleInfo.badgeText }}
                  >
                    {userRoleInfo.englishTitle}
                  </span>
                </div>
                <div className="hidden sm:block text-[10px]" style={{ color: 'var(--header-muted)' }}>
                  {currentUser.team || 'Agency'}
                </div>
              </div>
            </div>

            {/* Logout Button */}
            <button
              onClick={handleLogout}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-xs font-medium text-stone-300 hover:text-red-300 hover:bg-red-950/40 border border-transparent hover:border-red-900/40 transition-all"
              title="Sign out from session"
            >
              <LogOut className="w-3.5 h-3.5 text-red-400" />
              <span className="hidden sm:inline">Sign Out</span>
            </button>
          </div>
        </div>
        {testHandoff && authenticatedUser && (
          <div className="mx-auto mt-3 flex max-w-screen-2xl flex-wrap items-center justify-between gap-2 rounded-xl border border-amber-500 bg-amber-950/80 px-4 py-2 text-xs text-amber-100" role="status">
            <span className="font-bold">
              {isRealTestSession
                ? `TESTING SESSION — Logged in as ${authenticatedUser.name} — ${getRoleInfo(authenticatedUser.role).englishTitle}`
                : 'TESTING SESSION — Verifying employee Auth identity and RLS; do not test until verified'}
              {isRealTestSession && <span className="ml-2 font-normal">(real employee Supabase Auth and RLS session)</span>}
            </span>
            <button onClick={handleExitEmployeeTest} className="rounded-lg bg-amber-300 px-3 py-1 font-bold text-black hover:bg-amber-200">
              Exit Testing Session
            </button>
          </div>
        )}
        {impersonationHandoff && authenticatedUser && (
          <div className="mx-auto mt-3 flex max-w-screen-2xl flex-wrap items-center justify-between gap-2 rounded-xl border border-red-500 bg-red-950/80 px-4 py-2 text-xs text-red-100" role="status">
            <span className="font-bold">
              {isRealImpersonationSession
                ? `IMPERSONATING — Logged in as ${authenticatedUser.name} — ${getRoleInfo(authenticatedUser.role).englishTitle} (temporary transition tool, not a permanent feature)`
                : 'IMPERSONATING — Verifying employee Auth identity and RLS; do not act until verified'}
            </span>
            <button onClick={() => void handleExitImpersonation()} className="rounded-lg bg-red-300 px-3 py-1 font-bold text-black hover:bg-red-200">
              Exit Impersonation
            </button>
          </div>
        )}
      </header>

      {/* Sidebar + Content shell */}
      <div className="flex">
        {/* Backdrop, mobile only — closes the drawer on outside tap. z-[95] sits above
            the header (z-40) and the floating chat/AI buttons (z-[90]) so both are
            actually dimmed and untappable while the drawer is open, instead of
            visibly "poking through" the overlay. */}
        {isMobileSidebarOpen && (
          <div
            className="fixed inset-0 z-[95] bg-black/60 md:hidden"
            onClick={() => setIsMobileSidebarOpen(false)}
            aria-hidden="true"
          />
        )}

        {/* Left Sidebar Navigation - Filtered strictly by Employee's Role Permissions.
            Fixed off-canvas drawer below md (toggled via isMobileSidebarOpen), sticky
            in-flow column at md and up — same positioning/sizing either way. z-[96]
            keeps it above its own backdrop; dvh (not vh) so the drawer's height
            tracks the real visible viewport on mobile browsers whose address bar
            shrinks/grows the usable area. */}
        <aside
          className={`fixed md:sticky left-0 z-[96] md:z-auto w-60 shrink-0 border-r overflow-y-auto backdrop-blur-md transition-transform duration-200 ease-in-out md:translate-x-0 ${
            isMobileSidebarOpen ? 'translate-x-0' : '-translate-x-full'
          } ${(testHandoff || impersonationHandoff) ? 'top-[110px] h-[calc(100dvh-110px)]' : 'top-[65px] h-[calc(100dvh-65px)]'}`}
          style={{
            background: 'var(--navigation-surface)',
            borderColor: 'var(--nav-border)',
          }}
        >
          <div className="flex items-center justify-between px-4 pt-4 md:hidden">
            <span className="text-[11px] font-bold text-stone-400 uppercase tracking-wider">Menu</span>
            <button
              onClick={() => setIsMobileSidebarOpen(false)}
              className="p-1.5 rounded-lg text-stone-400 hover:text-white transition-colors"
              aria-label="Close navigation menu"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
          <nav className="flex flex-col gap-1.5 p-4">
            {/* Tab -1: My Work (personal landing view — clients/tasks/deadlines/daily log/performance) */}
            {userRoleInfo.allowedModules.includes('my_work') && (
              <button
                onClick={() => handleTabChange('my_work')}
                className={`w-full px-3.5 py-2.5 rounded-xl text-xs font-bold transition-all flex items-center gap-2.5 sidebar-nav-item ${
                  activeTab === 'my_work'
                  ? 'sidebar-nav-item--active ring-1 ring-purple-400 shadow-md'
                  : 'sidebar-nav-item--inactive'
                }`}
              >
                <Briefcase className="w-4 h-4 shrink-0" />
                <span className="flex-1 text-left">My Work</span>
              </button>
            )}

            {/* Tab 0: Leadership Dashboard */}
            {userRoleInfo.allowedModules.includes('dashboard') && (
              <button
                onClick={() => handleTabChange('dashboard')}
                className={`w-full px-3.5 py-2.5 rounded-xl text-xs font-bold transition-all flex items-center gap-2.5 sidebar-nav-item ${
                  activeTab === 'dashboard'
                  ? 'sidebar-nav-item--active ring-1 ring-purple-400 shadow-md'
                  : 'sidebar-nav-item--inactive'
                }`}
              >
                <Gauge className="w-4 h-4 shrink-0" />
                <span className="flex-1 text-left">Dashboard</span>
              </button>
            )}

            {/* Tab 1: Onboarding & Briefs — gated by canAccessClientOnboarding (not
                allowedModules), the same check AMQueue.tsx enforces, so this item is never shown
                to a role that would land on "Access Restricted" after clicking it. */}
            {canAccessClientOnboarding(currentUser.role) && (
              <button
                onClick={() => handleTabChange('onboarding')}
                className={`w-full px-3.5 py-2.5 rounded-xl text-xs font-bold transition-all flex items-center gap-2.5 sidebar-nav-item ${
                  activeTab === 'onboarding'
                  ? 'sidebar-nav-item--active ring-1 ring-purple-400 shadow-md'
                  : 'sidebar-nav-item--inactive'
                }`}
              >
                <FileText className="w-4 h-4 shrink-0" />
                <span className="flex-1 text-left">Client Onboarding</span>
                <span
                  className="px-1.5 py-0.2 rounded-full text-[10px] shrink-0 nav-badge"
                  style={{
                  background: 'rgba(123, 47, 247, 0.25)',
                  color: 'var(--white)',
                  }}
                >
                  {onboardingClientsCount}
                </span>
              </button>
            )}

            {/* Tab: Service Briefs Routing (service teams + AM) */}
            {userRoleInfo.allowedModules.includes('service_briefs') && (
              <button
                onClick={() => handleTabChange('service_briefs')}
                className={`w-full px-3.5 py-2.5 rounded-xl text-xs font-bold transition-all flex items-center gap-2.5 sidebar-nav-item ${
                  activeTab === 'service_briefs'
                  ? 'sidebar-nav-item--active ring-1 ring-purple-400 shadow-md'
                  : 'sidebar-nav-item--inactive'
                }`}
              >
                <Layers className="w-4 h-4 shrink-0" />
                <span className="flex-1 text-left">Service Briefs</span>
                <span
                  className="px-1.5 py-0.2 rounded-full text-[10px] shrink-0 nav-badge"
                  style={{
                  background: 'rgba(123, 47, 247, 0.25)',
                  color: 'var(--white)',
                  }}
                >
                  {briefs.length}
                </span>
              </button>
            )}

            {/* Tab 2: Capacity Management */}
            {userRoleInfo.allowedModules.includes('capacity') && (
              <button
                onClick={() => handleTabChange('capacity')}
                className={`w-full px-3.5 py-2.5 rounded-xl text-xs font-bold transition-all flex items-center gap-2.5 sidebar-nav-item ${
                  activeTab === 'capacity'
                  ? 'sidebar-nav-item--active ring-1 ring-purple-400 shadow-md'
                  : 'sidebar-nav-item--inactive'
                }`}
              >
                <Gauge className="w-4 h-4 shrink-0" />
                <span className="flex-1 text-left">Capacity Management</span>
                <span
                  className="px-1.5 py-0.2 rounded-full text-[10px] shrink-0 nav-badge"
                  style={{
                  background: 'rgba(169, 245, 193, 0.2)',
                  color: 'var(--roas-good)',
                  }}
                >
                  Live
                </span>
              </button>
            )}

            {/* Tab 3: Cross-Team Tasks */}
            {userRoleInfo.allowedModules.includes('tasks') && (
              <button
                onClick={() => handleTabChange('tasks')}
                className={`w-full px-3.5 py-2.5 rounded-xl text-xs font-bold transition-all flex items-center gap-2.5 sidebar-nav-item ${
                  activeTab === 'tasks'
                  ? 'sidebar-nav-item--active ring-1 ring-purple-400 shadow-md'
                  : 'sidebar-nav-item--inactive'
                }`}
              >
                <Kanban className="w-4 h-4 shrink-0" />
                <span className="flex-1 text-left">Task Board</span>
                <span
                  className="px-1.5 py-0.2 rounded-full text-[10px] shrink-0 nav-badge"
                  style={{
                  background: 'rgba(245, 226, 154, 0.2)',
                  color: 'var(--roas-mid)',
                  }}
                >
                  {activeTasksCount} active
                </span>
              </button>
            )}

            {/* Tab 4: Daily Operations & Task Execution */}
            {userRoleInfo.allowedModules.includes('daily_operations') && (
              <button
                onClick={() => handleTabChange('daily_operations')}
                className={`w-full px-3.5 py-2.5 rounded-xl text-xs font-bold transition-all flex items-center gap-2.5 sidebar-nav-item ${
                  activeTab === 'daily_operations'
                  ? 'sidebar-nav-item--active ring-1 ring-purple-400 shadow-md'
                  : 'sidebar-nav-item--inactive'
                }`}
              >
                <Clock className="w-4 h-4 shrink-0" />
                <span className="flex-1 text-left">Daily Operations</span>
                {blockedTasksCount > 0 ? (
                  <span className="px-1.5 py-0.2 rounded-full text-[10px] bg-red-950 text-red-300 border border-red-500/40 font-mono shrink-0">
                    {blockedTasksCount} blocked
                  </span>
                ) : (
                  <span
                    className="px-1.5 py-0.2 rounded-full text-[10px] shrink-0 nav-badge"
                    style={{
                    background: 'rgba(169, 245, 193, 0.2)',
                    color: 'var(--roas-good)',
                    }}
                  >
                    Active
                  </span>
                )}
              </button>
            )}

            {/* Tab 5: Campaign Management (Media Buying & Ads Hub) */}
            {userRoleInfo.allowedModules.includes('campaigns') && (
              <button
                onClick={() => handleTabChange('campaigns')}
                className={`w-full px-3.5 py-2.5 rounded-xl text-xs font-bold transition-all flex items-center gap-2.5 sidebar-nav-item ${
                  activeTab === 'campaigns'
                  ? 'sidebar-nav-item--active ring-1 ring-purple-400 shadow-md'
                  : 'sidebar-nav-item--inactive'
                }`}
              >
                <Target className="w-4 h-4 shrink-0" />
                <span className="flex-1 text-left">Campaigns</span>
                <span
                  className="px-1.5 py-0.2 rounded-full text-[10px] shrink-0 nav-badge"
                  style={{
                    background: 'rgba(14, 165, 233, 0.2)',
                    color: '#38bdf8',
                  }}
                >
                  {campaigns.filter((c) => (c.status || c.results?.status) === 'active').length} active
                </span>
              </button>
            )}

            {/* Tab 6: Reports & Comparisons (Reporting Engine) */}
            {userRoleInfo.allowedModules.includes('reports') && (
              <button
                onClick={() => handleTabChange('reports')}
                className={`w-full px-3.5 py-2.5 rounded-xl text-xs font-bold transition-all flex items-center gap-2.5 sidebar-nav-item ${
                  activeTab === 'reports'
                  ? 'sidebar-nav-item--active ring-1 ring-purple-400 shadow-md'
                  : 'sidebar-nav-item--inactive'
                }`}
              >
                <BarChart3 className="w-4 h-4 shrink-0" />
                <span className="flex-1 text-left">Reports</span>
              </button>
            )}

            {userRoleInfo.allowedModules.includes('employees') && (
              <button
                onClick={() => handleTabChange('employees')}
                className={`w-full px-3.5 py-2.5 rounded-xl text-xs font-bold transition-all flex items-center gap-2.5 sidebar-nav-item ${
                  activeTab === 'employees'
                  ? 'sidebar-nav-item--active ring-1 ring-purple-400 shadow-md'
                  : 'sidebar-nav-item--inactive'
                }`}
              >
                <UserPlus className="w-4 h-4 shrink-0" />
                <span className="flex-1 text-left">Employees</span>
              </button>
            )}

            {/* Live Activity Feed — mobile only; desktop keeps its own header button
                (hidden md:flex above) instead of duplicating it here. */}
            {['executive', 'head_of_technical', 'ai_engineer'].includes(currentUser.role) && (
              <div className="md:hidden mt-2 pt-2 border-t" style={{ borderColor: 'var(--border-soft)' }}>
                <button
                  onClick={() => {
                    setIsActivityFeedOpen(true);
                    setIsMobileSidebarOpen(false);
                  }}
                  className="w-full px-3.5 py-2.5 rounded-xl text-xs font-bold flex items-center gap-2.5 text-white"
                  style={{ background: 'var(--gradient-badge)', border: '1px solid var(--border-strong)' }}
                >
                  <div className="w-2 h-2 rounded-full bg-emerald-300 animate-pulse border border-emerald-500 shrink-0" />
                  <span className="flex-1 text-left">Live Activity Feed ⚡</span>
                </button>
              </div>
            )}
          </nav>
        </aside>
      {/* Main Workspace */}
      <main className="flex-1 min-w-0 max-w-screen-2xl mx-auto px-6 lg:px-10 pt-6 space-y-6">
        {/* Floating Notification */}
        {notification && (
          <div
            className="p-3.5 rounded-xl text-xs flex items-center justify-between gap-3 shadow-2xl transition-all"
            style={{
              background: 'var(--gradient-card)',
              border: '1px solid var(--purple)',
              color: 'var(--white)',
            }}
          >
            <div className="flex items-center gap-2">
              <CheckCircle2 className="w-4 h-4" style={{ color: 'var(--roas-good)' }} />
              <span>{notification.text}</span>
            </div>
            <button
              onClick={() => setNotification(null)}
              className="text-stone-400 hover:text-white text-xs px-2 py-0.5 rounded"
            >
              Close
            </button>
          </div>
        )}

        {/* Security & Access Protection: Unauthorized State Check */}
        {unauthorizedRoute ? (
          <AccessDenied
            currentUser={currentUser}
            attemptedModuleOrPortal={unauthorizedRoute}
            onNavigateToHomePortal={handleNavigateToHomePortal}
          />
        ) : !isModuleAllowed(currentUser.role, activeTab) ? (
          <AccessDenied
            currentUser={currentUser}
            attemptedModuleOrPortal={activeTab}
            onNavigateToHomePortal={handleNavigateToHomePortal}
          />
        ) : (
          <>
            {/* Dedicated Role-Based Portal Header (Dashboard tab only) */}
            {activeTab === 'dashboard' && (
              <RolePortalHeader
                currentUser={currentUser}
                tasks={tasks}
                clients={clients}
              />
            )}

            {/* Tab 0: Leadership Dashboard */}
            {activeTab === 'dashboard' && (
              <div className="space-y-6">
                <DashboardHub
                  currentUser={currentUser}
                  users={users}
                  clients={clients}
                  campaigns={campaigns}
                  tasks={tasks}
                  socialInsights={socialInsights}
                  assignments={assignments}
                  briefs={briefs}
                  onNavigateToModule={handleNavigateToModule}
                />
              </div>
            )}

            {/* Tab -1: My Work (personal landing view) */}
            {activeTab === 'my_work' && (
              <div className="space-y-6">
                <MyWorkHub
                  currentUser={currentUser}
                  clients={clients}
                  assignments={assignments}
                  tasks={tasks}
                  dailyLogs={dailyLogs}
                  extraNotes={extraNotes}
                  capacityLogs={capacityLogs}
                  onUpdateTaskStatus={handleUpdateTaskStatus}
                  onCreateDailyLog={handleCreateDailyLog}
                  onCreateExtraNote={handleCreateExtraNote}
                  onNavigateToModule={handleNavigateToModule}
                  onMarkTaskViewed={handleMarkTaskViewed}
                />
              </div>
            )}

            {/* Tab 1: Onboarding & Briefs or Sales Portal */}
            {activeTab === 'onboarding' && (
              <div className="space-y-6">
                {currentUser.role === 'sales' ? (
                  <SalesPortalView
                    currentUser={currentUser}
                    clients={clients}
                    users={users}
                    onOpenRegisterModal={() => setIsRegisterModalOpen(true)}
                    onOpenBulkUploadModal={() => setIsBulkClientUploadOpen(true)}
                    onUpdateClientStatus={handleUpdateClientStatus}
                    clientContracts={clientContracts}
                    onUploadClientContract={handleUploadClientContract}
                    onDeleteClientContract={handleDeleteClientContract}
                    briefFieldSchemas={briefFieldSchemas}
                    briefFieldSchemaRows={briefFieldSchemaRows}
                  />
                ) : (
                  <AMQueue
                    clients={clients}
                    users={users}
                    briefs={briefs}
                    briefRevisions={briefRevisions}
                    campaigns={campaigns}
                    tasks={tasks}
                    reports={reports}
                    clientComparisons={clientComparisons}
                    socialInsights={socialInsights}
                    clientPortalUsers={clientPortalUsers}
                    currentUser={currentUser}
                    currentUserId={currentUser.id}
                    onAssignAMAgent={handleAssignAMAgent}
                    onAssignAMTeamLead={handleAssignAMTeamLead}
                    onSaveBrief={handleSaveBrief}
                    onSubmitBrief={handleSubmitBrief}
                    briefFieldSchemas={briefFieldSchemas}
                    briefFieldSchemaRows={briefFieldSchemaRows}
                    onCreateBriefFieldSchema={handleCreateBriefFieldSchema}
                    onUpdateBriefFieldSchema={handleUpdateBriefFieldSchema}
                    onDeleteBriefFieldSchema={handleDeleteBriefFieldSchema}
                    onDeleteClient={handleDeleteClient}
                    onOpenRegisterModal={canRegisterClients ? () => setIsRegisterModalOpen(true) : undefined}
                    onOpenBulkUploadModal={canRegisterClients ? () => setIsBulkClientUploadOpen(true) : undefined}
                    onUpdateClientStatus={handleUpdateClientStatus}
                    onMarkClientViewed={handleMarkClientViewedByAMLead}
                    onNavigateToModule={handleNavigateToModule}
                    onGenerateComparison={handleGenerateComparison}
                    onGenerateReport={handleGenerateReport}
                    onGenerateMonthlyReportDraft={handleGenerateMonthlyReportDraft}
                    onApproveReport={handleApproveReport}
                    onCreatePortalLogin={handleCreatePortalLogin}
                    meetings={meetings}
                    onUploadMeetingRecording={handleUploadMeetingRecording}
                    onSaveMeetingNotes={handleSaveMeetingNotes}
                    platformConnections={platformConnections}
                    onSetPlatformConnectionStatus={handleSetPlatformConnectionStatus}
                    clientContracts={clientContracts}
                    onUploadClientContract={handleUploadClientContract}
                    onDeleteClientContract={handleDeleteClientContract}
                    onUpdatePaymentTracking={handleUpdatePaymentTracking}
                    onUpdateClientAccess={handleUpdateClientAccess}
                  />
                )}
              </div>
            )}

            {/* Tab: Service Briefs Routing (service teams review/assign; AM reviews across services) */}
            {activeTab === 'service_briefs' && (
              <div className="space-y-6">
                <ServiceBriefsRoutingView
                  currentUser={currentUser}
                  clients={clients}
                  briefs={briefs}
                  briefRevisions={briefRevisions}
                  assignments={assignments}
                  users={users}
                  campaigns={campaigns}
                  tasks={tasks}
                  dailyLogs={dailyLogs}
                  extraNotes={extraNotes}
                  reports={reports}
                  clientComparisons={clientComparisons}
                  socialInsights={socialInsights}
                  clientPortalUsers={clientPortalUsers}
                  onAssignServiceAgent={handleAssignServiceAgent}
                  onSaveBrief={handleSaveBrief}
                  onSubmitBrief={handleSubmitBrief}
                  briefFieldSchemas={briefFieldSchemas}
                  briefFieldSchemaRows={briefFieldSchemaRows}
                  onCreateBriefFieldSchema={handleCreateBriefFieldSchema}
                  onUpdateBriefFieldSchema={handleUpdateBriefFieldSchema}
                  onDeleteBriefFieldSchema={handleDeleteBriefFieldSchema}
                  onDeleteClient={handleDeleteClient}
                  onMarkBriefViewed={handleMarkBriefViewedByTeamLead}
                  onMarkAssignmentViewed={handleMarkAssignmentViewed}
                  onNavigateToModule={handleNavigateToModule}
                  onGenerateComparison={handleGenerateComparison}
                  onGenerateReport={handleGenerateReport}
                  onGenerateMonthlyReportDraft={handleGenerateMonthlyReportDraft}
                  onApproveReport={handleApproveReport}
                  onCreatePortalLogin={handleCreatePortalLogin}
                  platformConnections={platformConnections}
                  onSetPlatformConnectionStatus={handleSetPlatformConnectionStatus}
                  onUpdatePaymentTracking={handleUpdatePaymentTracking}
                  onUpdateClientAccess={handleUpdateClientAccess}
                />
              </div>
            )}

            {/* Tab 2: Capacity Management Module */}
            {activeTab === 'capacity' && (
              <div className="space-y-6">
                <CapacityManagement
                  users={users}
                  clients={clients}
                  tasks={tasks}
                  capacityLogs={capacityLogs}
                  currentUser={currentUser}
                  onUpdateUserCapacity={handleUpdateUserCapacity}
                  onLogCapacity={handleLogCapacity}
                  onNavigateToModule={handleNavigateToModule}
                  extraNotes={extraNotes}
                />
              </div>
            )}

            {/* Tab 3: Cross-Team Shared Task Board */}
            {activeTab === 'tasks' && (
              <div className="space-y-6">
                <CrossTeamTaskBoard
                  tasks={tasks}
                  users={users}
                  clients={clients}
                  currentUser={currentUser}
                  currentUserId={currentUser.id}
                  onUpdateTaskStatus={handleUpdateTaskStatus}
                  onCreateTask={handleCreateTask}
                  onUpdateTask={handleUpdateTask}
                  initialAssigneeFilter={taskBoardAssigneePrefill}
                  taskComments={taskComments}
                  onAddTaskComment={handleAddTaskComment}
                  onEditTaskComment={handleEditTaskComment}
                  onDeleteTaskComment={handleDeleteTaskComment}
                  taskAttachments={taskAttachments}
                  onUploadTaskAttachment={handleUploadTaskAttachment}
                  onDeleteTaskAttachment={handleDeleteTaskAttachment}
                />
              </div>
            )}

            {/* Tab 4: Daily Operations & Task Execution */}
            {activeTab === 'daily_operations' && (
              <div className="space-y-6">
                <DailyOperationsModule
                  tasks={tasks}
                  users={users}
                  clients={clients}
                  briefs={briefs}
                  dailyLogs={dailyLogs}
                  extraNotes={extraNotes}
                  currentUser={currentUser}
                  onUpdateTaskStatus={handleUpdateTaskStatus}
                  onUpdateTask={handleUpdateTask}
                  onCreateDailyLog={handleCreateDailyLog}
                  onCreateExtraNote={handleCreateExtraNote}
                />
              </div>
            )}

            {/* Tab 5: Campaign Management (Media Buying & Advertising Hub) */}
            {activeTab === 'campaigns' && (
              <div className="space-y-6">
                <CampaignManagementModule
                  campaigns={campaigns}
                  clients={clients}
                  users={users}
                  currentUser={currentUser}
                  briefs={briefs}
                  briefRevisions={briefRevisions}
                  tasks={tasks}
                  dailyLogs={dailyLogs}
                  extraNotes={extraNotes}
                  assignments={assignments}
                  reports={reports}
                  clientComparisons={clientComparisons}
                  socialInsights={socialInsights}
                  clientPortalUsers={clientPortalUsers}
                  onCreateCampaign={handleCreateCampaign}
                  onUpdateCampaign={handleUpdateCampaign}
                  onGenerateComparison={handleGenerateComparison}
                  onGenerateReport={handleGenerateReport}
                  onGenerateMonthlyReportDraft={handleGenerateMonthlyReportDraft}
                  onApproveReport={handleApproveReport}
                  onCreatePortalLogin={handleCreatePortalLogin}
                  platformConnections={platformConnections}
                  onSetPlatformConnectionStatus={handleSetPlatformConnectionStatus}
                  isLoading={loading}
                  briefFieldSchemas={briefFieldSchemas}
                  briefFieldSchemaRows={briefFieldSchemaRows}
                  onDeleteClient={handleDeleteClient}
                  onUpdatePaymentTracking={handleUpdatePaymentTracking}
                  onUpdateClientAccess={handleUpdateClientAccess}
                />
              </div>
            )}

            {/* Tab 6: Reports & Comparisons (Reporting Engine) */}
            {activeTab === 'reports' && (
              <div className="space-y-6">
                <ReportsHub
                  currentUser={currentUser}
                  users={users}
                  clients={clients}
                  assignments={assignments}
                  reports={reports}
                  clientComparisons={clientComparisons}
                  dailyLogs={dailyLogs}
                  onGenerateComparison={handleGenerateComparison}
                  onGenerateReport={handleGenerateReport}
                />
              </div>
            )}

            {/* Tab 7: Add Employee (admin) */}
            {activeTab === 'employees' && (
              <div className="space-y-6">
                <EmployeeAdminHub
                  currentUser={currentUser}
                  users={users}
                  clients={clients}
                  tasks={tasks}
                  onAddEmployee={handleAddEmployee}
                  onUpdateEmployee={handleUpdateEmployee}
                  onDeactivateEmployee={handleDeactivateEmployee}
                />
              </div>
            )}
          </>
        )}
        </main>
      </div>

      {/* Client registration */}
      {canAccessTestingMode && isTestingSelectorOpen && usersLoadedFromSupabase && (
        <EmployeeTestingMode
          employees={users}
          onClose={() => setIsTestingSelectorOpen(false)}
          onInspect={(employeeId) => invokeTestAccount('status', employeeId)}
          onSetup={(employeeId, password) => invokeTestAccount('setup', employeeId, password)}
          onGenerateTestPassword={generateTestPassword}
          onStart={handleStartEmployeeTest}
        />
      )}
      {/* TEMPORARY TRANSITION FEATURE — see the constants near the top of this file. */}
      {canAccessImpersonation && isImpersonationSelectorOpen && usersLoadedFromSupabase && (
        <EmployeeImpersonation
          employees={users}
          onClose={() => setIsImpersonationSelectorOpen(false)}
          onStart={handleStartImpersonation}
        />
      )}
      <ClientRegistrationModal
        isOpen={canRegisterClients && isRegisterModalOpen}
        onClose={() => setIsRegisterModalOpen(false)}
        currentUser={currentUser}
        amTeamLeaders={(currentUser.role === 'sales' || currentUser.role === 'am_agent' || usersLoadedFromSupabase)
          ? users.filter((u) => u.role === 'am_team_lead' && isActiveEmployee(u)) : []}
        amAgents={usersLoadedFromSupabase ? users.filter((u) => u.role === 'am_agent' && isActiveEmployee(u)) : []}
        onSubmit={handleRegisterClient}
      />

      <BulkClientUploadModal
        isOpen={canRegisterClients && isBulkClientUploadOpen}
        onClose={() => setIsBulkClientUploadOpen(false)}
        currentUser={currentUser}
        users={(currentUser.role === 'sales' || currentUser.role === 'am_agent' || usersLoadedFromSupabase) ? users : []}
        clients={clients}
        onAddClientRow={handleBulkAddClient}
      />

      <ImportDataModal
        isOpen={isImportModalOpen}
        onClose={() => setIsImportModalOpen(false)}
        type={importType}
        onImport={(data, method) => {
          console.log(`Importing ${importType} via ${method}:`, data);
          alert('تم استيراد البيانات بنجاح (Simulation)');
        }}
      />

      {/* --- New Global Features --- */}
      <GlobalSearch users={users} tasks={tasks} clients={clients} />
      <AIAssistantWidget />
      
      <MiniChat
        currentUser={currentUser}
        users={chatDirectory}
        messages={chatMessages}
        conversationClears={chatConversationClears}
        onSendMessage={handleSendChatMessage}
        onUploadChatAttachment={handleUploadChatAttachment}
        onEditMessage={handleEditChatMessage}
        onDeleteMessage={handleDeleteChatMessage}
        onClearConversation={handleClearChatConversation}
        onOpenConversation={handleOpenChatConversation}
        openConversationRequest={chatOpenRequest}
        onlineUserIds={onlineUserIds}
      />

      {/* Activity Feed Drawer */}
      {isActivityFeedOpen && (
        <div className="fixed inset-y-0 left-0 w-80 z-[80] animate-in slide-in-from-left shadow-2xl border-r border-white/10 p-4 pt-[80px]" style={{ background: 'var(--gradient-card)' }}>
          <LiveActivityFeed activities={activities} users={users} onClose={() => setIsActivityFeedOpen(false)} />
        </div>
      )}
    </div>
  );
}

