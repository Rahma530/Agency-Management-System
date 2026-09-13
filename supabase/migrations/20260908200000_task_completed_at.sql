-- ============================================================================
-- Daily Work Log auto-suggestion: tasks.completed_at
-- ============================================================================
-- Needed to reliably filter "tasks completed today" — status alone tells you
-- a task is currently completed, not when. Set/cleared at the app layer
-- (src/App.tsx's handleUpdateTaskStatus / handleUpdateTask), matching this
-- schema's existing convention for this class of field (edited_at/
-- deleted_at on comments, uploaded_at on attachments, team_lead_viewed_at on
-- briefs are all app-set, not trigger-set) — not backfilled for existing
-- completed rows, since a stale completion has no correct "today" value to
-- assign anyway.
-- ============================================================================

alter table public.tasks add column if not exists completed_at timestamptz;
