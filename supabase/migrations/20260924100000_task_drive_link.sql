-- ============================================================================
-- Module 12, Phase 9: manual "Drive Link" field for tasks.
-- ============================================================================
--
-- A generic nullable column on tasks (not creative-team-scoped at the DB or
-- RLS level) — the original ask was Creative tasks specifically
-- (graphic_designer/video_editor/programming_agent), but there is no real
-- Google Drive API integration here (same scaffolding-only posture as every
-- other Module 6 integration point), so this is just a manually-pasted URL.
-- Restricting it to certain teams would add complexity for a plain text
-- field any task could reasonably carry; anyone who can already update a
-- task (tasks_update_rls, unchanged) can set it.
-- ============================================================================

begin;

alter table public.tasks add column if not exists drive_link text;

commit;
