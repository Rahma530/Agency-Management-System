import React, { useState, useEffect, useCallback } from 'react';
import {
  Database,
  PlusCircle,
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
} from 'lucide-react';
import { supabase, isSupabaseConfigured, setSupabaseSessionUser } from './lib/supabase';
import {
  ClientRecord,
  PackageRecord,
  UserRecord,
  BriefRecord,
  TaskRecord,
  CapacityLogRecord,
  DailyLogRecord,
  ExtraNoteRecord,
  CampaignRecord,
  ServiceType,
  UserRole,
  TaskStatus,
  TaskPriority,
  NotificationRecord,
  ActivityRecord,
  ChatMessageRecord,
} from './types/database';
import {
  INITIAL_PACKAGES,
  INITIAL_USERS,
  INITIAL_CLIENTS,
  INITIAL_BRIEFS,
  INITIAL_TASKS,
  INITIAL_CAPACITY_LOGS,
  INITIAL_DAILY_LOGS,
  INITIAL_EXTRA_NOTES,
  INITIAL_CAMPAIGNS,
} from './data/initialData';
import {
  getRoleInfo,
  isModuleAllowed,
  getPortalSlug,
  AppModuleId,
} from './data/roles';
import { EmployeeLogin } from './components/EmployeeLogin';
import { ClientRegistrationModal } from './components/ClientRegistrationModal';
import { AMQueue } from './components/AMQueue';
import { CapacityManagement } from './components/CapacityManagement';
import { CrossTeamTaskBoard } from './components/CrossTeamTaskBoard';
import { DailyOperationsModule } from './components/DailyOperationsModule';
import { ImportDataModal } from './components/ImportDataModal';
import { CampaignManagementModule } from './components/CampaignManagementModule';
import { SalesPortalView } from './components/SalesPortalView';
import { AccessDenied } from './components/AccessDenied';
import { RolePortalHeader } from './components/RolePortalHeader';
import { OnlineUsersWidget } from './components/OnlineUsersWidget';
import { NotificationBell } from './components/NotificationBell';
import { GlobalSearch } from './components/GlobalSearch';
import { LiveActivityFeed } from './components/LiveActivityFeed';
import { MiniChat } from './components/MiniChat';

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
  const [packages, setPackages] = useState<PackageRecord[]>(INITIAL_PACKAGES);
  const [users, setUsers] = useState<UserRecord[]>(INITIAL_USERS);
  const [clients, setClients] = useState<ClientRecord[]>(INITIAL_CLIENTS);
  const [briefs, setBriefs] = useState<BriefRecord[]>(INITIAL_BRIEFS);
  const [tasks, setTasks] = useState<TaskRecord[]>(INITIAL_TASKS);
  const [capacityLogs, setCapacityLogs] = useState<CapacityLogRecord[]>(INITIAL_CAPACITY_LOGS);
  const [dailyLogs, setDailyLogs] = useState<DailyLogRecord[]>(INITIAL_DAILY_LOGS);
  const [extraNotes, setExtraNotes] = useState<ExtraNoteRecord[]>(INITIAL_EXTRA_NOTES);
  const [campaigns, setCampaigns] = useState<CampaignRecord[]>(INITIAL_CAMPAIGNS);
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
  const [isActivityFeedOpen, setIsActivityFeedOpen] = useState(false);

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

  const [isRegisterModalOpen, setIsRegisterModalOpen] = useState(false);
  const [notification, setNotification] = useState<{ text: string; type: 'success' | 'info' } | null>(null);

  // Current active user based on authenticated session
  const currentUser: UserRecord = authenticatedUser || (users && users.length > 0 ? users[0] : INITIAL_USERS[0]);
  const userRoleInfo = getRoleInfo(currentUser?.role || 'sales');

  const showNotification = (text: string, type: 'success' | 'info' = 'success') => {
    setNotification({ text, type });
    setTimeout(() => setNotification(null), 4500);
  };

  const handleMarkNotificationAsRead = (id: string) => {
    setNotifications(prev => prev.map(n => n.id === id ? { ...n, is_read: true } : n));
  };

  const handleMarkAllNotificationsAsRead = () => {
    setNotifications(prev => prev.map(n => ({ ...n, is_read: true })));
  };

  // 1. Session Rehydration from Supabase on mount
  useEffect(() => {
    const restoreSession = async () => {
      if (isSupabaseConfigured()) {
        try {
          const { data: { session } } = await supabase.auth.getSession();
          if (session?.user) {
            const { data: dbUser } = await supabase
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
          const matched = users.find((u) => u.id === savedUserId);
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
        if (session?.user) {
          const { data: dbUser } = await supabase
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
  }, [users]);

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
      const validModules: AppModuleId[] = ['onboarding', 'capacity', 'tasks', 'daily_operations', 'campaigns'];
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
  const handleTabChange = (newTab: AppModule) => {
    if (!authenticatedUser) return;
    if (!isModuleAllowed(authenticatedUser.role, newTab)) {
      setUnauthorizedRoute(`#/${newTab}`);
      return;
    }
    setActiveTab(newTab);
    setUnauthorizedRoute(null);
    const mySlug = getPortalSlug(authenticatedUser.role);
    window.location.hash = `#/portal/${mySlug}/${newTab}`;
  };

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

    // 1. Fetch users strictly through RLS-enforced Supabase query layer
    try {
      if (authenticatedUser) {
        const { data: userData, error: userErr } = await supabase.from('users').select('*');
        if (!userErr && userData && userData.length > 0) {
          setUsers(userData as UserRecord[]);
        }
      } else {
        setUsers(INITIAL_USERS);
      }
    } catch (err) {
      console.warn('Error fetching users under RLS:', err);
    }

    if (configured) {
      try {
        // Fetch packages
        const { data: pkgData, error: pkgErr } = await supabase.from('packages').select('*');
        if (!pkgErr && pkgData && pkgData.length > 0) {
          setPackages(pkgData as PackageRecord[]);
        }

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

        // Fetch tasks
        const { data: taskData, error: taskErr } = await supabase.from('tasks').select('*');
        if (!taskErr && taskData && taskData.length > 0) {
          setTasks(taskData as TaskRecord[]);
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
      } catch (err) {
        console.warn('Supabase query error, relying on local cached state:', err);
      }
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    setSupabaseSessionUser(authenticatedUser);
    loadData();
  }, [authenticatedUser, loadData]);

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

  // 1. تسجيل عميل جديد من فريق المبيعات (مع تحويل تلقائي إلى Onboarding)
  const handleRegisterClient = async (clientData: {
    name: string;
    industry: string;
    package_id: string;
    contract_value: number;
    start_date: string;
    am_team_lead_id?: string;
  }) => {
    const newClientPayload: Partial<ClientRecord> = {
      id: `cl-${Date.now().toString().slice(-4)}`,
      name: clientData.name,
      industry: clientData.industry,
      package_id: clientData.package_id,
      status: 'onboarding', // تحويل تلقائي فوري لقسم إدارة الحسابات
      sales_owner_id: currentUser.id,
      am_agent_id: null, // بانتظار تعيين مدير الحساب
      am_team_lead_id: clientData.am_team_lead_id || 'usr-am-lead',
      contract_value: clientData.contract_value,
      start_date: clientData.start_date,
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

    showNotification(
      `تم تسجيل العميل «${clientData.name}» وتحويله تلقائياً لقائمة انتظار مسؤول إدارة الحسابات بنجاح!`
    );
  };

  // 2. إسناد العميل لموظف إدارة حسابات (AM Agent)
  const handleAssignAMAgent = async (clientId: string, agentId: string) => {
    if (supabaseActive) {
      try {
        const { error } = await supabase
          .from('clients')
          .update({ am_agent_id: agentId })
          .eq('id', clientId);
        if (error) throw error;
      } catch (err: any) {
        console.error('Supabase assign error:', err);
      }
    }

    setClients((prev) =>
      prev.map((c) => (c.id === clientId ? { ...c, am_agent_id: agentId } : c))
    );

    const agent = users.find((u) => u.id === agentId);
    showNotification(`تم إسناد العميل لمسؤول إدارة الحسابات: ${agent?.name || agentId}`);
  };

  // 3. حفظ نموذج البريف الديناميكي (SEO، سوشيال ميديا، ميديا باينج)
  const handleSaveBrief = async (briefData: {
    client_id: string;
    service_type: ServiceType;
    fields: Record<string, any>;
    version: number;
    submitted_by: string;
  }) => {
    const existingIndex = briefs.findIndex(
      (b) => b.client_id === briefData.client_id && b.service_type === briefData.service_type
    );

    let updatedBriefs: BriefRecord[] = [];

    if (existingIndex >= 0) {
      const existing = briefs[existingIndex];
      const updated: BriefRecord = {
        ...existing,
        fields: briefData.fields,
        version: existing.version + 1,
        submitted_by: briefData.submitted_by,
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
              updated_at: updated.updated_at,
            })
            .eq('id', existing.id);
        } catch (err) {
          console.error('Supabase brief update error:', err);
        }
      }

      updatedBriefs = [...briefs];
      updatedBriefs[existingIndex] = updated;
    } else {
      const newBrief: BriefRecord = {
        id: `brf-${Date.now().toString().slice(-4)}`,
        client_id: briefData.client_id,
        service_type: briefData.service_type,
        fields: briefData.fields,
        version: 1,
        submitted_by: briefData.submitted_by,
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
    }

    setBriefs(updatedBriefs);
    showNotification('تم توثيق وحفظ البريف كنسخة رسمية في قاعدة البيانات بنجاح.');
  };

  // 4. تحديث السعة القصوى للموظف (Capacity Limit)
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

    showNotification('تم تحديث السعة الاستيعابية للموظف بنجاح.');
  };

  // تسجيل قراءة سعة استيعابية جديدة
  const handleLogCapacity = async (newLog: CapacityLogRecord) => {
    if (supabaseActive) {
      try {
        await supabase.from('capacity_logs').insert([newLog]);
      } catch (err) {
        console.error('Supabase capacity_logs insert error:', err);
      }
    }
    setCapacityLogs((prev) => [newLog, ...prev]);
    showNotification('تم توثيق قراءة السعة الاستيعابية بنجاح.');
  };

  // 5. تحديث حالة المهمة في اللوحة المشتركة
  const handleUpdateTaskStatus = async (taskId: string, newStatus: TaskStatus) => {
    if (supabaseActive) {
      try {
        await supabase
          .from('tasks')
          .update({ status: newStatus })
          .eq('id', taskId);
      } catch (err) {
        console.error('Supabase task update error:', err);
      }
    }

    setTasks((prev) =>
      prev.map((t) => (t.id === taskId ? { ...t, status: newStatus } : t))
    );

    showNotification('تم نقل حالة المهمة وتحديث اللوحة المشتركة.');
  };

  // تحديث تفاصيل وساعات المهمة
  const handleUpdateTask = async (taskId: string, updates: Partial<TaskRecord>) => {
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

    showNotification('تم تحديث بيانات المهمة بنجاح.');
  };

  // 6. إضافة مهمة مشتركة جديدة
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

    showNotification(`تمت إضافة المهمة «${taskData.title}» إلى لوحة المهام المشتركة بنجاح!`);
  };

  // 7. توثيق تقرير النشاط اليومي (Daily Log)
  const handleCreateDailyLog = async (logData: {
    user_id: string;
    date: string;
    summary_text: string;
    linked_task_ids: string[];
  }) => {
    const newLogPayload: DailyLogRecord = {
      id: `log-${Date.now().toString().slice(-4)}`,
      user_id: logData.user_id,
      date: logData.date,
      summary_text: logData.summary_text,
      linked_task_ids: logData.linked_task_ids,
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

    showNotification('تم تسجيل وحفظ تقرير النشاط اليومي في قاعدة البيانات بنجاح.');
  };

  // 8. توثيق ملاحظة إضافية أو تعثر (Extra Notes)
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

  // 9. إنشاء وتحديث الحملات الإعلانية (Campaign Management)
  const handleCreateCampaign = async (campaignData: Partial<CampaignRecord>) => {
    const newId = `cmp-${Date.now().toString().slice(-4)}`;
    const newRecord: CampaignRecord = {
      id: newId,
      client_id: campaignData.client_id || '',
      name: campaignData.name || 'حملة إعلانية ممولة',
      platform: campaignData.platform || 'meta',
      campaign_id_external: campaignData.campaign_id_external || null,
      objective: campaignData.objective || 'التحويلات والمبيعات',
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

    showNotification(`تم إنشاء وتفعيل الحملة «${newRecord.name}» بنجاح!`);
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

    showNotification('تم تحديث بيانات الحملة الإعلانية بنجاح.');
  };

  // Stats for badge counters
  const activeTasksCount = tasks.filter((t) => t.status !== 'completed').length;
  const onboardingClientsCount = clients.filter((c) => c.status === 'onboarding').length;
  const blockedTasksCount = tasks.filter((t) => t.status === 'blocked').length;

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
    <div className="min-h-screen text-[#e9d9fb] pb-16 font-['Tajawal',sans-serif]" dir="rtl" style={{ background: 'var(--gradient-page)' }}>
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
                  نظام تشغيلي
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

            {/* Sales Action Button: Add Client (Role Permission Check) */}
            {userRoleInfo.canRegisterClients && (
              <button
                onClick={() => setIsRegisterModalOpen(true)}
                className="flex items-center gap-2 px-4 py-2 rounded-xl text-xs font-bold transition-all shadow-lg hover:opacity-90 active:scale-98"
                style={{
                  background: 'var(--gradient-badge)',
                  color: 'var(--white)',
                  border: '1px solid var(--border-strong)',
                }}
              >
                <PlusCircle className="w-4 h-4" />
                <span>New Client</span>
              </button>
            )}
          </div>
        </div>
      </header>

      {/* Primary Navigation Tabs - Filtered strictly by Employee's Role Permissions */}
      <div
        className="border-b px-6 sticky top-[65px] z-30 backdrop-blur-md"
        style={{
          background: 'rgba(15, 12, 22, 0.95)',
          borderColor: 'var(--border-soft)',
        }}
      >
        <div className="max-w-7xl mx-auto flex items-center justify-between gap-4 overflow-x-auto py-2">
          <nav className="flex items-center gap-2">
            {/* Tab 1: Onboarding & Briefs */}
            {userRoleInfo.allowedModules.includes('onboarding') && (
              <button
                onClick={() => handleTabChange('onboarding')}
                className={`px-4 py-2 rounded-xl text-xs font-bold transition-all flex items-center gap-2 ${
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
                <FileText className="w-4 h-4" />
                <span>Client Onboarding</span>
                <span
                  className="px-1.5 py-0.2 rounded-full text-[10px]"
                  style={{
                    background: activeTab === 'onboarding' ? 'rgba(255, 255, 255, 0.2)' : 'rgba(123, 47, 247, 0.25)',
                    color: 'var(--white)',
                  }}
                >
                  {onboardingClientsCount}
                </span>
              </button>
            )}

            {/* Tab 2: Capacity Management */}
            {userRoleInfo.allowedModules.includes('capacity') && (
              <button
                onClick={() => handleTabChange('capacity')}
                className={`px-4 py-2 rounded-xl text-xs font-bold transition-all flex items-center gap-2 ${
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
                <Gauge className="w-4 h-4" />
                <span>Capacity Management</span>
                <span
                  className="px-1.5 py-0.2 rounded-full text-[10px]"
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
                className={`px-4 py-2 rounded-xl text-xs font-bold transition-all flex items-center gap-2 ${
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
                <Kanban className="w-4 h-4" />
                <span>Task Board</span>
                <span
                  className="px-1.5 py-0.2 rounded-full text-[10px]"
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
                className={`px-4 py-2 rounded-xl text-xs font-bold transition-all flex items-center gap-2 ${
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
                <Clock className="w-4 h-4" />
                <span>Daily Operations</span>
                {blockedTasksCount > 0 ? (
                  <span className="px-1.5 py-0.2 rounded-full text-[10px] bg-red-950 text-red-300 border border-red-500/40 font-mono">
                    {blockedTasksCount} blocked
                  </span>
                ) : (
                  <span
                    className="px-1.5 py-0.2 rounded-full text-[10px]"
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
                className={`px-4 py-2 rounded-xl text-xs font-bold transition-all flex items-center gap-2 ${
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
                <Target className="w-4 h-4" />
                <span>Campaigns</span>
                <span
                  className="px-1.5 py-0.2 rounded-full text-[10px]"
                  style={{
                    background: activeTab === 'campaigns' ? 'rgba(255, 255, 255, 0.2)' : 'rgba(14, 165, 233, 0.2)',
                    color: activeTab === 'campaigns' ? 'var(--white)' : '#38bdf8',
                  }}
                >
                  {campaigns.filter((c) => (c.status || c.results?.status) === 'active').length} active
                </span>
              </button>
            )}
          </nav>

          <div className="flex items-center gap-3">
            {/* Import / Manage Data Buttons */}
            {['executive', 'head_of_technical'].includes(currentUser.role) && (
              <div className="flex items-center gap-3">
                <button
                  onClick={() => {
                    setImportType('clients');
                    setIsImportModalOpen(true);
                  }}
                  className="flex items-center gap-2 px-4 py-2 rounded-xl text-xs font-bold transition-all shadow-lg hover:shadow-purple-500/20 hover:-translate-y-0.5 active:translate-y-0 text-white"
                  style={{ background: 'var(--gradient-badge)', border: '1px solid var(--border-strong)' }}
                >
                  <Building2 className="w-4 h-4" />
                  <span>إدارة وإضافة العملاء</span>
                </button>
                <button
                  onClick={() => {
                    setImportType('users');
                    setIsImportModalOpen(true);
                  }}
                  className="flex items-center gap-2 px-4 py-2 rounded-xl text-xs font-bold transition-all shadow-lg hover:shadow-purple-500/20 hover:-translate-y-0.5 active:translate-y-0 text-white"
                  style={{ background: 'var(--gradient-badge)', border: '1px solid var(--border-strong)' }}
                >
                  <Users className="w-4 h-4" />
                  <span>إدارة وإضافة الموظفين</span>
                </button>
                <div className="h-6 w-px bg-white/10 hidden md:block mx-1" />
              </div>
            )}

            <button
              onClick={loadData}
              className="p-1.5 rounded-lg text-stone-300 hover:text-white transition-colors shrink-0"
              style={{ background: 'rgba(255, 255, 255, 0.05)', border: '1px solid var(--border-soft)' }}
              title="Refresh data"
            >
              <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} />
            </button>
          </div>
        </div>
      </div>

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
              إغلاق
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
              onOpenRegisterModal={userRoleInfo.canRegisterClients ? () => setIsRegisterModalOpen(true) : undefined}
            />

            {/* Tab 1: Onboarding & Briefs or Sales Portal */}
            {activeTab === 'onboarding' && (
              <div className="space-y-6">
                {currentUser.role === 'sales' ? (
                  <SalesPortalView
                    currentUser={currentUser}
                    clients={clients}
                    packages={packages}
                    users={users}
                    onOpenRegisterModal={() => setIsRegisterModalOpen(true)}
                  />
                ) : (
                  <AMQueue
                    clients={clients}
                    packages={packages}
                    users={users}
                    briefs={briefs}
                    currentUser={currentUser}
                    currentUserId={currentUser.id}
                    onAssignAMAgent={handleAssignAMAgent}
                    onSaveBrief={handleSaveBrief}
                  />
                )}
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
                  onCreateCampaign={handleCreateCampaign}
                  onUpdateCampaign={handleUpdateCampaign}
                  isLoading={loading}
                />
              </div>
            )}
          </>
        )}
      </main>

      {/* Modal: Client Registration by Sales */}
      <ClientRegistrationModal
        isOpen={isRegisterModalOpen}
        onClose={() => setIsRegisterModalOpen(false)}
        packages={packages}
        amTeamLeaders={users.filter((u) => u.role === 'am_team_lead')}
        onSubmit={handleRegisterClient}
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
      
      <MiniChat 
        currentUser={currentUser} 
        users={users} 
        messages={chatMessages} 
        onSendMessage={(receiverId, content) => {
          const newMsg: ChatMessageRecord = {
            id: `msg-${Date.now()}`,
            sender_id: currentUser.id,
            receiver_id: receiverId,
            content,
            is_read: false,
            created_at: new Date().toISOString(),
          };
          setChatMessages(prev => [...prev, newMsg]);
        }} 
      />

      {/* Activity Feed Drawer */}
      {isActivityFeedOpen && (
        <div className="fixed inset-y-0 left-0 w-80 z-[80] animate-in slide-in-from-left shadow-2xl border-r border-white/10 p-4 pt-[80px]" style={{ background: 'var(--gradient-card)' }}>
          <LiveActivityFeed activities={activities} users={users} />
        </div>
      )}
    </div>
  );
}

