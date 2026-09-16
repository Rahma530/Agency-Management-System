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
import { resolvePeriodRange, generateKpiScoreMetrics, suggestClassification } from './lib/performanceScore';
import { isActiveEmployee } from './lib/permissions';
import { groupBriefFieldSchemas } from './data/briefFieldSchemas';
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
  KpiScoreRecord,
  PerformancePeriodType,
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
  INITIAL_CLIENTS,
  INITIAL_BRIEFS,
  INITIAL_TASKS,
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

export default function App() {
  const [supabaseActive, setSupabaseActive] = useState(false);
  const [loading, setLoading] = useState(true);

  // Active module tab
  const [activeTab, setActiveTab] = useState<AppModule>('onboarding');
  const [unauthorizedRoute, setUnauthorizedRoute] = useState<string | null>(null);
  
  // Online Users Mock State
  const [onlineUserIds, setOnlineUserIds] = useState<string[]>([]);

  // Data State
  const [users, setUsers] = useState<UserRecord[]>(INITIAL_USERS);
  const [clients, setClients] = useState<ClientRecord[]>(INITIAL_CLIENTS);
  const [briefs, setBriefs] = useState<BriefRecord[]>(INITIAL_BRIEFS);
  const [briefRevisions, setBriefRevisions] = useState<BriefRevisionRecord[]>([]);
  // Global per-service brief question list — moved here from a static import (data/briefFieldSchemas.ts)
  // so it can be edited from the app. briefFieldSchemas below is the grouped Record<ServiceType,
  // BriefFieldDef[]> shape every render call site needs; briefFieldSchemaRows is the raw rows (with
  // id) the schema editor needs for update/delete.
  const [briefFieldSchemaRows, setBriefFieldSchemaRows] = useState<BriefFieldSchemaRow[]>([]);
  const briefFieldSchemas = useMemo(() => groupBriefFieldSchemas(briefFieldSchemaRows), [briefFieldSchemaRows]);
  const [tasks, setTasks] = useState<TaskRecord[]>(INITIAL_TASKS);
  const [taskComments, setTaskComments] = useState<TaskCommentRecord[]>([]);
  const [taskAttachments, setTaskAttachments] = useState<TaskAttachmentRecord[]>([]);
  const [capacityLogs, setCapacityLogs] = useState<CapacityLogRecord[]>(INITIAL_CAPACITY_LOGS);
  const [dailyLogs, setDailyLogs] = useState<DailyLogRecord[]>(INITIAL_DAILY_LOGS);
  const [extraNotes, setExtraNotes] = useState<ExtraNoteRecord[]>(INITIAL_EXTRA_NOTES);
  const [kpiScores, setKpiScores] = useState<KpiScoreRecord[]>([]);
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
  const [notification, setNotification] = useState<{ text: string; type: 'success' | 'info' } | null>(null);

  // Current active user based on authenticated session
  const currentUser: UserRecord = authenticatedUser || (users && users.length > 0 ? users[0] : INITIAL_USERS[0]);
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
              .or(`auth_id.eq.${session.user.id},email.eq.${session.user.email}`)
              .single();
            if (dbUser) {
              setAuthenticatedUser(dbUser as UserRecord);
              return;
            }
          }
        } catch (err) {
          console.warn('Session check warning:', err);
        }
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
            .or(`auth_id.eq.${session.user.id},email.eq.${session.user.email}`)
            .single();
          if (dbUser) {
            setAuthenticatedUser(dbUser as UserRecord);
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
  }, [authenticatedUser]);

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

  const handleLoginSuccess = (user: UserRecord) => {
    setAuthenticatedUser(user);
    setSupabaseSessionUser(user);
    setUnauthorizedRoute(null);
    const roleMeta = getRoleInfo(user.role);
    setActiveTab(roleMeta.defaultModule);
    window.location.hash = `#/portal/${roleMeta.portalSlug}/${roleMeta.defaultModule}`;
    showNotification(`Welcome, ${user.name} (${roleMeta.portalTitleEn})`);
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
        const { data: dbUser } = await supabase
          .from('users')
          .select('*')
          .or(`auth_id.eq.${session.user.id},email.eq.${session.user.email}`)
          .single();
        if (dbUser) {
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
  const loadData = useCallback(async () => {
    setLoading(true);
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
        const { data: clientData, error: clientErr } = await supabase.from('clients').select('*');
        if (!clientErr && clientData && clientData.length > 0) {
          setClients(clientData as ClientRecord[]);
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
        const { data: taskData, error: taskErr } = await supabase.from('tasks').select('*');
        if (!taskErr && taskData && taskData.length > 0) {
          setTasks(taskData as TaskRecord[]);
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

        // Fetch kpi_scores
        const { data: kpiData, error: kpiErr } = await supabase.from('kpi_scores').select('*');
        if (!kpiErr && kpiData && kpiData.length > 0) {
          setKpiScores(kpiData as KpiScoreRecord[]);
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
  }, [authenticatedUser]);

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

  useEffect(() => {
    setSupabaseSessionUser(authenticatedUser);
    loadData();
  }, [authenticatedUser, loadData]);

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

  // Mock online users logic
  useEffect(() => {
    if (authenticatedUser && users.length > 0) {
      // Always include current user
      const ids = [authenticatedUser.id];
      // Add 3 other random users to look "online"
      const others = users.filter((u) => u.id !== authenticatedUser.id);
      
      // We will pick the first 3 for simplicity, but shifted by the day so it looks random but stable per session
      for (let i = 0; i < Math.min(3, others.length); i++) {
        ids.push(others[i].id);
      }
      setOnlineUserIds(ids);
    }
  }, [authenticatedUser, users]);

  // 1. Single-client registration (ClientRegistrationModal.tsx) — shared by sales, am_team_lead,
  // and am_agent now, branching on currentUser.role exactly like handleBulkAddClient's three-way
  // split below: sales still creates a new-pipeline lead (status 'onboarding', sales_owner_id =
  // self, that creation IS the Sales -> AM Team Lead handoff); am_team_lead/am_agent register an
  // already-active client they manage (status 'active', sales_owner_id null, am_agent_id = self
  // for an am_agent with am_agent_assigned_at stamped, am_team_lead_id resolved from the form's
  // picker either way). Same clients_insert_am_rls policy already covers this — it's the same
  // clients INSERT regardless of whether it came from this single form or the bulk uploader.
  const handleRegisterClient = async (clientData: {
    name: string;
    industry: string;
    services: ServiceType[];
    phone_number?: string;
    contract_value: number;
    start_date: string;
    renewal_date: string;
    am_team_lead_id?: string;
  }) => {
    const isAmRegistration = currentUser.role === 'am_team_lead' || currentUser.role === 'am_agent';
    const newClientPayload: Partial<ClientRecord> = {
      id: `cl-${Date.now().toString().slice(-4)}`,
      name: clientData.name,
      industry: clientData.industry,
      services: clientData.services,
      phone_number: clientData.phone_number || null,
      status: isAmRegistration ? 'active' : 'onboarding',
      sales_owner_id: isAmRegistration ? null : currentUser.id,
      am_agent_id: currentUser.role === 'am_agent' ? currentUser.id : null,
      am_agent_assigned_at: currentUser.role === 'am_agent' ? new Date().toISOString() : null,
      am_team_lead_id: clientData.am_team_lead_id || 'usr-am-lead',
      contract_value: clientData.contract_value,
      start_date: clientData.start_date,
      renewal_date: clientData.renewal_date,
      created_at: new Date().toISOString(),
    };

    if (supabaseActive) {
      try {
        const { data, error } = await supabase
          .from('clients')
          .insert([newClientPayload])
          .select();
        if (error) throw error;
        if (data && data[0]) {
          setClients((prev) => [data[0] as ClientRecord, ...prev]);
        } else {
          setClients((prev) => [newClientPayload as ClientRecord, ...prev]);
        }
      } catch (err: any) {
        console.error('Supabase error inserting client:', err);
        setClients((prev) => [newClientPayload as ClientRecord, ...prev]);
      }
    } else {
      setClients((prev) => [newClientPayload as ClientRecord, ...prev]);
    }

    await logActivity('create', 'client', newClientPayload.id!, newClientPayload.name!, `Registered new client in ${newClientPayload.industry}`);

    showNotification(
      isAmRegistration
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
  // Branches on the uploading user's role — the modal itself doesn't know or care which path it's
  // on, it just resolves the same columns (including am_team_lead_id, required for every path) and
  // hands them here:
  //   - sales: new-pipeline lead, sales_owner_id = self, status starts at 'onboarding' — matches
  //     clients_insert_sales_rls exactly.
  //   - am_agent: an already-active client of their own, am_agent_id = self (agents only manage
  //     their own book), sales_owner_id stays null, status starts at 'active', and
  //     am_agent_assigned_at is stamped now so it isn't invisible to MyWorkHub's gained/lost
  //     metrics from creation.
  //   - am_team_lead: an already-active client, am_team_lead_id comes from the resolved column
  //     (may be themselves or a peer lead), am_agent_id stays null (awaiting individual AM
  //     assignment, same "unassigned at creation" convention the sales path already uses), status
  //     starts at 'active'.
  // Matches the additive clients_insert_am_rls policy (20260929100000_client_bulk_upload_am_rls.sql)
  // for the am_agent/am_team_lead branches; clients_insert_sales_rls is untouched for sales.
  const handleBulkAddClient = async (clientData: {
    name: string;
    industry: string;
    services: ServiceType[];
    phone_number?: string;
    contract_value: number;
    start_date: string;
    renewal_date: string;
    am_team_lead_id: string;
  }) => {
    const isAmUpload = currentUser.role === 'am_team_lead' || currentUser.role === 'am_agent';
    const newClientPayload: Partial<ClientRecord> = {
      id: `cl-${Date.now().toString().slice(-4)}-${Math.random().toString(36).slice(2, 6)}`,
      name: clientData.name,
      industry: clientData.industry,
      services: clientData.services,
      phone_number: clientData.phone_number || null,
      status: isAmUpload ? 'active' : 'onboarding',
      sales_owner_id: isAmUpload ? null : currentUser.id,
      am_agent_id: currentUser.role === 'am_agent' ? currentUser.id : null,
      am_agent_assigned_at: currentUser.role === 'am_agent' ? new Date().toISOString() : null,
      am_team_lead_id: clientData.am_team_lead_id,
      contract_value: clientData.contract_value,
      start_date: clientData.start_date,
      renewal_date: clientData.renewal_date,
      created_at: new Date().toISOString(),
    };

    if (supabaseActive) {
      const { data, error } = await supabase.from('clients').insert([newClientPayload]).select();
      if (error) throw error;
      setClients((prev) => [(data?.[0] as ClientRecord) || (newClientPayload as ClientRecord), ...prev]);
    } else {
      setClients((prev) => [newClientPayload as ClientRecord, ...prev]);
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

  // 2. Assign the client to an Account Manager (AM Agent)
  const handleAssignAMAgent = async (clientId: string, agentId: string) => {
    // Module 13 Phase 4: only bump am_agent_assigned_at on an actual change of agent — a no-op
    // resubmission of the same agent shouldn't re-date the "gained" moment. Mirrors the
    // reassignment-clears-viewed_at convention from Module 12 Phase 5.
    const existing = clients.find((c) => c.id === clientId);
    const isReassignment = existing?.am_agent_id !== agentId;
    const assignedAt = isReassignment ? new Date().toISOString() : existing?.am_agent_assigned_at;

    if (supabaseActive) {
      try {
        const { error } = await supabase
          .from('clients')
          .update({ am_agent_id: agentId, am_agent_assigned_at: assignedAt })
          .eq('id', clientId);
        if (error) throw error;
      } catch (err: any) {
        console.error('Supabase assign error:', err);
      }
    }

    setClients((prev) =>
      prev.map((c) => (c.id === clientId ? { ...c, am_agent_id: agentId, am_agent_assigned_at: assignedAt } : c))
    );

    const agent = users.find((u) => u.id === agentId);
    showNotification(`Client assigned to Account Manager: ${agent?.name || agentId}`);
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

    if (supabaseActive) {
      try {
        const { error } = await supabase
          .from('clients')
          .update(updatePayload)
          .eq('id', clientId);
        if (error) throw error;
      } catch (err: any) {
        console.error('Supabase update client status error:', err);
      }
    }

    setClients((prev) =>
      prev.map((c) => (c.id === clientId ? { ...c, ...updatePayload } : c))
    );

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
    if (supabaseActive) {
      const { error } = await supabase.from('clients').delete().eq('id', clientId);
      if (error) {
        console.error('Supabase delete client error:', error);
        showNotification('Unable to delete this client — it may still have related records.', 'info');
        throw error;
      }
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
    if (supabaseActive) {
      try {
        const { error } = await supabase.from('clients').update(updates).eq('id', clientId);
        if (error) throw error;
      } catch (err: any) {
        console.error('Supabase update payment tracking error:', err);
        showNotification('Unable to save payment tracking.', 'info');
        return;
      }
    }

    setClients((prev) => prev.map((c) => (c.id === clientId ? { ...c, ...updates } : c)));
    showNotification('Payment tracking updated.');
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

    if (supabaseActive) {
      try {
        const { error } = await supabase
          .from('clients')
          .update({ am_team_lead_viewed_at: viewedAt })
          .eq('id', clientId);
        if (error) throw error;
      } catch (err: any) {
        console.error('Supabase mark client viewed error:', err);
      }
    }

    setClients((prev) =>
      prev.map((c) => (c.id === clientId ? { ...c, am_team_lead_viewed_at: viewedAt } : c))
    );
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
    const teamLeadId = users.find((u) => u.id === agentId)?.manager_id || currentUser.id;

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

  // 3b. Mark a brief as viewed by the relevant service Team Lead (clears its "New" indicator)
  const handleMarkBriefViewedByTeamLead = async (briefId: string) => {
    const viewedAt = new Date().toISOString();

    if (supabaseActive) {
      try {
        const { error } = await supabase
          .from('briefs')
          .update({ team_lead_viewed_at: viewedAt })
          .eq('id', briefId);
        if (error) throw error;
      } catch (err: any) {
        console.error('Supabase mark brief viewed error:', err);
      }
    }

    setBriefs((prev) =>
      prev.map((b) => (b.id === briefId ? { ...b, team_lead_viewed_at: viewedAt } : b))
    );
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
    // completed_at is the only reliable signal for "completed today" (the
    // Daily Work Log's auto-suggestion) — status alone carries no timing
    // information, so it's set/cleared here rather than left to drift.
    const completedAt = newStatus === 'completed' ? new Date().toISOString() : null;
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
    
    const taskTitle = tasks.find(t => t.id === taskId)?.title || 'Task';
    await logActivity('status_change', 'task', taskId, taskTitle, `Status updated to ${newStatus}`);

    showNotification('Task status moved and the shared board updated.');
  };

  // Update task details and hours
  const handleUpdateTask = async (taskId: string, updates: Partial<TaskRecord>) => {
    // Same completed_at bookkeeping as handleUpdateTaskStatus, but only when
    // this edit actually touches status — editing title/description alone
    // shouldn't disturb it.
    const finalUpdates: Partial<TaskRecord> = { ...updates };
    if ('status' in updates) {
      finalUpdates.completed_at = updates.status === 'completed' ? new Date().toISOString() : null;
    }
    // Reassigning a task to a different person is a fresh "new task" for them (Module 12
    // Phase 5's programming_agent notification badge, since that role has no assignments row).
    if ('assigned_to' in updates) {
      const existingTask = tasks.find((t) => t.id === taskId);
      if (existingTask && existingTask.assigned_to !== updates.assigned_to) {
        finalUpdates.assignee_viewed_at = null;
      }
    }

    if (supabaseActive) {
      try {
        await supabase
          .from('tasks')
          .update(finalUpdates)
          .eq('id', taskId);
      } catch (err) {
        console.error('Supabase task update error:', err);
      }
    }

    setTasks((prev) =>
      prev.map((t) => (t.id === taskId ? { ...t, ...finalUpdates } : t))
    );
    
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

    if (supabaseActive) {
      try {
        const { data, error } = await supabase.from('tasks').insert([newTaskPayload]).select();
        if (error) throw error;
        if (data && data[0]) {
          setTasks((prev) => [data[0] as TaskRecord, ...prev]);
        } else {
          setTasks((prev) => [newTaskPayload, ...prev]);
        }
      } catch (err: any) {
        console.error('Supabase task insert error:', err);
        setTasks((prev) => [newTaskPayload, ...prev]);
      }
    } else {
      setTasks((prev) => [newTaskPayload, ...prev]);
    }

    await logActivity('create', 'task', newTaskPayload.id, newTaskPayload.title, `Created task for team: ${newTaskPayload.team}`);

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

  // 8b. Generate (or regenerate) an employee's KPI score for a period —
  // upserts by (user_id, period), so re-running the same period overwrites
  // rather than accumulating duplicate rows.
  const handleGenerateKpiScore = async (
    userId: string,
    periodType: PerformancePeriodType,
    referenceDate: Date
  ) => {
    const targetUser = users.find((u) => u.id === userId);
    if (!targetUser) return;

    const range = resolvePeriodRange(periodType, referenceDate);
    const { metrics, overallScore } = generateKpiScoreMetrics(targetUser, range, tasks, clients, extraNotes);

    const existing = kpiScores.find((k) => k.user_id === userId && k.period === range.period);
    const scorePayload: KpiScoreRecord = {
      id: existing?.id || `kpi-${Date.now().toString().slice(-4)}`,
      user_id: userId,
      period: range.period,
      metrics,
      overall_score: overallScore,
      reviewed_by: currentUser.id,
      created_at: existing?.created_at || new Date().toISOString(),
    };

    // Classification suggestion (advisory only — see performanceScore.ts): judged against this
    // period and whatever came before it, never periods that hadn't happened yet from this
    // period's point of view, so backfilling an earlier period can't retroactively borrow trend
    // evidence from a later one.
    const classificationHistory = [...kpiScores.filter((k) => k.user_id === userId && k.period !== range.period), scorePayload]
      .filter((k) => (k.metrics?.period_start || '') <= range.start)
      .sort((a, b) => (a.metrics?.period_start || '').localeCompare(b.metrics?.period_start || ''));
    scorePayload.suggested_status = suggestClassification(classificationHistory).suggestedStatus;

    if (supabaseActive) {
      try {
        const { data, error } = await supabase
          .from('kpi_scores')
          .upsert([scorePayload], { onConflict: 'user_id,period' })
          .select();
        if (error) throw error;
        const saved = (data?.[0] as KpiScoreRecord) || scorePayload;
        setKpiScores((prev) => [...prev.filter((k) => k.id !== saved.id), saved]);
      } catch (err) {
        console.error('Supabase kpi_scores upsert error:', err);
        showNotification('Unable to save the performance score.', 'info');
        return;
      }
    } else {
      setKpiScores((prev) => [...prev.filter((k) => k.id !== scorePayload.id), scorePayload]);
    }

    showNotification(`Performance score generated for ${targetUser.name} (${range.period}).`);
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
  const activeTasksCount = tasks.filter((t) => t.status !== 'completed').length;
  const onboardingClientsCount = clients.filter((c) => c.status === 'onboarding').length;
  const blockedTasksCount = tasks.filter((t) => t.status === 'blocked').length;

  // MiniChat send: insert a real row via supabaseRaw first, only append locally on success —
  // same "persist, then sync local state" pattern as handleUpdateEmployee/
  // handleDeactivateEmployee. Not appending optimistically-then-rolling-back on failure avoids
  // ever showing a message that didn't actually reach the other person.
  const handleSendChatMessage = async (receiverId: string, content: string): Promise<boolean> => {
    const newMsg: ChatMessageRecord = {
      id: `msg-${Date.now()}`,
      sender_id: currentUser.id,
      receiver_id: receiverId,
      content,
      is_read: false,
      created_at: new Date().toISOString(),
    };
    if (supabaseActive) {
      try {
        const { error } = await supabaseRaw.from('chat_messages').insert(newMsg);
        if (error) throw error;
      } catch (err: any) {
        console.error('Failed to send chat message:', err);
        showNotification('Unable to send message.', 'info');
        return false;
      }
    }
    setChatMessages((prev) => [...prev, newMsg]);
    return true;
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
      <EmployeeLogin
        users={users}
        onLoginSuccess={handleLoginSuccess}
        supabaseActive={supabaseActive}
      />
    );
  }

  return (
    <div className="min-h-screen text-[#e9d9fb] pb-16" dir="ltr" style={{ background: 'var(--gradient-page)' }}>
      {/* Top Navigation Bar adhering to Kesra Brand Identity */}
      <header
        className="sticky top-0 z-40 backdrop-blur-md px-6 py-3.5 border-b"
        style={{
          background: 'rgba(10, 10, 13, 0.9)',
          borderColor: 'var(--border-soft)',
        }}
      >
        <div className="max-w-7xl mx-auto flex flex-wrap items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            <div
              className="w-10 h-10 rounded-[12px] flex items-center justify-center shadow-lg font-bold text-lg"
              style={{
                background: 'var(--gradient-badge)',
                border: '1px solid var(--border-strong)',
                color: 'var(--white)',
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
              <p className="text-xs" style={{ color: 'var(--grey)' }}>
                Client Lifecycle • Capacity Monitoring • Cross-Team Collaboration
              </p>
            </div>
          </div>

          <div className="flex items-center gap-3">
            {/* زر النشاط الحي للمديرين */}
            {['executive', 'head_of_technical'].includes(currentUser.role) && (
              <button
                onClick={() => setIsActivityFeedOpen(!isActivityFeedOpen)}
                className="text-xs px-4 py-2 rounded-xl font-bold flex items-center gap-2 transition-all shadow-lg hover:shadow-purple-500/20 hover:-translate-y-0.5 active:translate-y-0 text-white"
                style={{ background: 'var(--gradient-badge)', border: '1px solid var(--border-strong)' }}
              >
                <div className="w-2 h-2 rounded-full bg-emerald-300 animate-pulse border border-emerald-500" />
                Live Activity Feed ⚡
              </button>
            )}

            {/* Notification Bell */}
            <NotificationBell
              notifications={notifications.filter(n => n.user_id === currentUser.id)}
              users={users}
              onMarkAsRead={handleMarkNotificationAsRead}
              onMarkAllAsRead={handleMarkAllNotificationsAsRead}
              onNotificationClick={handleNotificationClick}
            />

            {/* Online Users Widget */}
            <OnlineUsersWidget users={users} tasks={tasks} clients={clients} onlineUserIds={onlineUserIds} />

            {/* Supabase Status Indicator */}
            <div
              className="flex items-center gap-2 px-3 py-1.5 rounded-xl text-xs"
              style={{
                background: 'rgba(21, 19, 24, 0.9)',
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
              className="p-1.5 rounded-lg text-stone-300 hover:text-white transition-colors shrink-0"
              style={{ background: 'rgba(255, 255, 255, 0.05)', border: '1px solid var(--border-soft)' }}
              title="Refresh data"
            >
              <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} />
            </button>

            {/* Authenticated Employee Badge & Portal Indicator */}
            <div
              className="flex items-center gap-2.5 px-3 py-1.5 rounded-xl border backdrop-blur-md shadow-sm"
              style={{
                background: 'rgba(28, 22, 38, 0.85)',
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
                <div className="text-xs font-bold text-white flex items-center gap-1.5">
                  <span>{currentUser.name}</span>
                  <span
                    className="px-1.5 py-0.2 rounded text-[10px] font-semibold"
                    style={{ background: userRoleInfo.badgeBg, color: userRoleInfo.badgeText }}
                  >
                    {userRoleInfo.englishTitle}
                  </span>
                </div>
                <div className="text-[10px] text-[#a89bb8]">
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
      </header>

      {/* Sidebar + Content shell */}
      <div className="flex">
        {/* Left Sidebar Navigation - Filtered strictly by Employee's Role Permissions */}
        <aside
          className="w-60 shrink-0 border-r sticky top-[65px] h-[calc(100vh-65px)] overflow-y-auto backdrop-blur-md"
          style={{
            background: 'rgba(15, 12, 22, 0.95)',
            borderColor: 'var(--border-soft)',
          }}
        >
          <nav className="flex flex-col gap-1.5 p-4">
            {/* Tab -1: My Work (personal landing view — clients/tasks/deadlines/daily log/performance) */}
            {userRoleInfo.allowedModules.includes('my_work') && (
              <button
                onClick={() => handleTabChange('my_work')}
                className={`w-full px-3.5 py-2.5 rounded-xl text-xs font-bold transition-all flex items-center gap-2.5 ${
                  activeTab === 'my_work'
                    ? 'ring-1 ring-purple-400 shadow-md'
                    : 'text-stone-400 hover:text-white'
                }`}
                style={{
                  background: activeTab === 'my_work' ? 'var(--gradient-badge)' : 'transparent',
                  color: activeTab === 'my_work' ? 'var(--white)' : 'var(--lilac)',
                  border: `1px solid ${activeTab === 'my_work' ? 'var(--border-strong)' : 'transparent'}`,
                }}
              >
                <Briefcase className="w-4 h-4 shrink-0" />
                <span className="flex-1 text-left">My Work</span>
              </button>
            )}

            {/* Tab 0: Leadership Dashboard */}
            {userRoleInfo.allowedModules.includes('dashboard') && (
              <button
                onClick={() => handleTabChange('dashboard')}
                className={`w-full px-3.5 py-2.5 rounded-xl text-xs font-bold transition-all flex items-center gap-2.5 ${
                  activeTab === 'dashboard'
                    ? 'ring-1 ring-purple-400 shadow-md'
                    : 'text-stone-400 hover:text-white'
                }`}
                style={{
                  background: activeTab === 'dashboard' ? 'var(--gradient-badge)' : 'transparent',
                  color: activeTab === 'dashboard' ? 'var(--white)' : 'var(--lilac)',
                  border: `1px solid ${activeTab === 'dashboard' ? 'var(--border-strong)' : 'transparent'}`,
                }}
              >
                <Gauge className="w-4 h-4 shrink-0" />
                <span className="flex-1 text-left">Dashboard</span>
              </button>
            )}

            {/* Tab 1: Onboarding & Briefs */}
            {userRoleInfo.allowedModules.includes('onboarding') && (
              <button
                onClick={() => handleTabChange('onboarding')}
                className={`w-full px-3.5 py-2.5 rounded-xl text-xs font-bold transition-all flex items-center gap-2.5 ${
                  activeTab === 'onboarding'
                    ? 'ring-1 ring-purple-400 shadow-md'
                    : 'text-stone-400 hover:text-white'
                }`}
                style={{
                  background: activeTab === 'onboarding' ? 'var(--gradient-badge)' : 'transparent',
                  color: activeTab === 'onboarding' ? 'var(--white)' : 'var(--lilac)',
                  border: `1px solid ${activeTab === 'onboarding' ? 'var(--border-strong)' : 'transparent'}`,
                }}
              >
                <FileText className="w-4 h-4 shrink-0" />
                <span className="flex-1 text-left">Client Onboarding</span>
                <span
                  className="px-1.5 py-0.2 rounded-full text-[10px] shrink-0"
                  style={{
                    background: activeTab === 'onboarding' ? 'rgba(255, 255, 255, 0.2)' : 'rgba(123, 47, 247, 0.25)',
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
                className={`w-full px-3.5 py-2.5 rounded-xl text-xs font-bold transition-all flex items-center gap-2.5 ${
                  activeTab === 'service_briefs'
                    ? 'ring-1 ring-purple-400 shadow-md'
                    : 'text-stone-400 hover:text-white'
                }`}
                style={{
                  background: activeTab === 'service_briefs' ? 'var(--gradient-badge)' : 'transparent',
                  color: activeTab === 'service_briefs' ? 'var(--white)' : 'var(--lilac)',
                  border: `1px solid ${activeTab === 'service_briefs' ? 'var(--border-strong)' : 'transparent'}`,
                }}
              >
                <Layers className="w-4 h-4 shrink-0" />
                <span className="flex-1 text-left">Service Briefs</span>
                <span
                  className="px-1.5 py-0.2 rounded-full text-[10px] shrink-0"
                  style={{
                    background: activeTab === 'service_briefs' ? 'rgba(255, 255, 255, 0.2)' : 'rgba(123, 47, 247, 0.25)',
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
                className={`w-full px-3.5 py-2.5 rounded-xl text-xs font-bold transition-all flex items-center gap-2.5 ${
                  activeTab === 'capacity'
                    ? 'ring-1 ring-purple-400 shadow-md'
                    : 'text-stone-400 hover:text-white'
                }`}
                style={{
                  background: activeTab === 'capacity' ? 'var(--gradient-badge)' : 'transparent',
                  color: activeTab === 'capacity' ? 'var(--white)' : 'var(--lilac)',
                  border: `1px solid ${activeTab === 'capacity' ? 'var(--border-strong)' : 'transparent'}`,
                }}
              >
                <Gauge className="w-4 h-4 shrink-0" />
                <span className="flex-1 text-left">Capacity Management</span>
                <span
                  className="px-1.5 py-0.2 rounded-full text-[10px] shrink-0"
                  style={{
                    background: activeTab === 'capacity' ? 'rgba(255, 255, 255, 0.2)' : 'rgba(169, 245, 193, 0.2)',
                    color: activeTab === 'capacity' ? 'var(--white)' : 'var(--roas-good)',
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
                className={`w-full px-3.5 py-2.5 rounded-xl text-xs font-bold transition-all flex items-center gap-2.5 ${
                  activeTab === 'tasks'
                    ? 'ring-1 ring-purple-400 shadow-md'
                    : 'text-stone-400 hover:text-white'
                }`}
                style={{
                  background: activeTab === 'tasks' ? 'var(--gradient-badge)' : 'transparent',
                  color: activeTab === 'tasks' ? 'var(--white)' : 'var(--lilac)',
                  border: `1px solid ${activeTab === 'tasks' ? 'var(--border-strong)' : 'transparent'}`,
                }}
              >
                <Kanban className="w-4 h-4 shrink-0" />
                <span className="flex-1 text-left">Task Board</span>
                <span
                  className="px-1.5 py-0.2 rounded-full text-[10px] shrink-0"
                  style={{
                    background: activeTab === 'tasks' ? 'rgba(255, 255, 255, 0.2)' : 'rgba(245, 226, 154, 0.2)',
                    color: activeTab === 'tasks' ? 'var(--white)' : 'var(--roas-mid)',
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
                className={`w-full px-3.5 py-2.5 rounded-xl text-xs font-bold transition-all flex items-center gap-2.5 ${
                  activeTab === 'daily_operations'
                    ? 'ring-1 ring-purple-400 shadow-md'
                    : 'text-stone-400 hover:text-white'
                }`}
                style={{
                  background: activeTab === 'daily_operations' ? 'var(--gradient-badge)' : 'transparent',
                  color: activeTab === 'daily_operations' ? 'var(--white)' : 'var(--lilac)',
                  border: `1px solid ${activeTab === 'daily_operations' ? 'var(--border-strong)' : 'transparent'}`,
                }}
              >
                <Clock className="w-4 h-4 shrink-0" />
                <span className="flex-1 text-left">Daily Operations</span>
                {blockedTasksCount > 0 ? (
                  <span className="px-1.5 py-0.2 rounded-full text-[10px] bg-red-950 text-red-300 border border-red-500/40 font-mono shrink-0">
                    {blockedTasksCount} blocked
                  </span>
                ) : (
                  <span
                    className="px-1.5 py-0.2 rounded-full text-[10px] shrink-0"
                    style={{
                      background: activeTab === 'daily_operations' ? 'rgba(255, 255, 255, 0.2)' : 'rgba(169, 245, 193, 0.2)',
                      color: activeTab === 'daily_operations' ? 'var(--white)' : 'var(--roas-good)',
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
                className={`w-full px-3.5 py-2.5 rounded-xl text-xs font-bold transition-all flex items-center gap-2.5 ${
                  activeTab === 'campaigns'
                    ? 'ring-1 ring-purple-400 shadow-md'
                    : 'text-stone-400 hover:text-white'
                }`}
                style={{
                  background: activeTab === 'campaigns' ? 'var(--gradient-badge)' : 'transparent',
                  color: activeTab === 'campaigns' ? 'var(--white)' : 'var(--lilac)',
                  border: `1px solid ${activeTab === 'campaigns' ? 'var(--border-strong)' : 'transparent'}`,
                }}
              >
                <Target className="w-4 h-4 shrink-0" />
                <span className="flex-1 text-left">Campaigns</span>
                <span
                  className="px-1.5 py-0.2 rounded-full text-[10px] shrink-0"
                  style={{
                    background: activeTab === 'campaigns' ? 'rgba(255, 255, 255, 0.2)' : 'rgba(14, 165, 233, 0.2)',
                    color: activeTab === 'campaigns' ? 'var(--white)' : '#38bdf8',
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
                className={`w-full px-3.5 py-2.5 rounded-xl text-xs font-bold transition-all flex items-center gap-2.5 ${
                  activeTab === 'reports'
                    ? 'ring-1 ring-purple-400 shadow-md'
                    : 'text-stone-400 hover:text-white'
                }`}
                style={{
                  background: activeTab === 'reports' ? 'var(--gradient-badge)' : 'transparent',
                  color: activeTab === 'reports' ? 'var(--white)' : 'var(--lilac)',
                  border: `1px solid ${activeTab === 'reports' ? 'var(--border-strong)' : 'transparent'}`,
                }}
              >
                <BarChart3 className="w-4 h-4 shrink-0" />
                <span className="flex-1 text-left">Reports</span>
              </button>
            )}

            {userRoleInfo.allowedModules.includes('employees') && (
              <button
                onClick={() => handleTabChange('employees')}
                className={`w-full px-3.5 py-2.5 rounded-xl text-xs font-bold transition-all flex items-center gap-2.5 ${
                  activeTab === 'employees'
                    ? 'ring-1 ring-purple-400 shadow-md'
                    : 'text-stone-400 hover:text-white'
                }`}
                style={{
                  background: activeTab === 'employees' ? 'var(--gradient-badge)' : 'transparent',
                  color: activeTab === 'employees' ? 'var(--white)' : 'var(--lilac)',
                  border: `1px solid ${activeTab === 'employees' ? 'var(--border-strong)' : 'transparent'}`,
                }}
              >
                <UserPlus className="w-4 h-4 shrink-0" />
                <span className="flex-1 text-left">Employees</span>
              </button>
            )}
          </nav>
        </aside>
      {/* Main Workspace */}
      <main className="max-w-7xl mx-auto px-6 pt-6 space-y-6">
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
            {/* Dedicated Role-Based Portal Header */}
            <RolePortalHeader
              currentUser={currentUser}
              tasks={tasks}
              clients={clients}
            />

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
                  kpiScores={kpiScores}
                  onNavigateToModule={handleNavigateToModule}
                />
              </div>
            )}

            {/* Tab -1: My Work (personal landing view) */}
            {activeTab === 'my_work' && (
              <div className="space-y-6">
                <MyWorkHub
                  currentUser={currentUser}
                  users={users}
                  clients={clients}
                  assignments={assignments}
                  tasks={tasks}
                  dailyLogs={dailyLogs}
                  extraNotes={extraNotes}
                  kpiScores={kpiScores}
                  capacityLogs={capacityLogs}
                  onUpdateTaskStatus={handleUpdateTaskStatus}
                  onCreateDailyLog={handleCreateDailyLog}
                  onCreateExtraNote={handleCreateExtraNote}
                  onGenerateKpiScore={handleGenerateKpiScore}
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
                    onSaveBrief={handleSaveBrief}
                    briefFieldSchemas={briefFieldSchemas}
                    briefFieldSchemaRows={briefFieldSchemaRows}
                    onCreateBriefFieldSchema={handleCreateBriefFieldSchema}
                    onUpdateBriefFieldSchema={handleUpdateBriefFieldSchema}
                    onDeleteBriefFieldSchema={handleDeleteBriefFieldSchema}
                    onDeleteClient={handleDeleteClient}
                    onOpenRegisterModal={() => setIsRegisterModalOpen(true)}
                    onOpenBulkUploadModal={() => setIsBulkClientUploadOpen(true)}
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
                  kpiScores={kpiScores}
                  onGenerateKpiScore={handleGenerateKpiScore}
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

      {/* Modal: Client Registration by Sales */}
      <ClientRegistrationModal
        isOpen={isRegisterModalOpen}
        onClose={() => setIsRegisterModalOpen(false)}
        currentUser={currentUser}
        amTeamLeaders={users.filter((u) => u.role === 'am_team_lead' && isActiveEmployee(u))}
        onSubmit={handleRegisterClient}
      />

      <BulkClientUploadModal
        isOpen={isBulkClientUploadOpen}
        onClose={() => setIsBulkClientUploadOpen(false)}
        currentUser={currentUser}
        users={users}
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
        onEditMessage={handleEditChatMessage}
        onDeleteMessage={handleDeleteChatMessage}
        onClearConversation={handleClearChatConversation}
        onOpenConversation={handleOpenChatConversation}
        openConversationRequest={chatOpenRequest}
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

