-- Removes public.task_visible(text, text, text) — the pre-task_visible_v2 visibility check.
--
-- Confirmed dead, not just unused-looking: 20261104100000_task_visibility_cutover.sql (the
-- migration that moved every tasks/task_comments/task_attachments policy over to
-- task_visible_v2) says so explicitly in its own closing notes: "task_visible(text, text, text)
-- itself is deliberately left in place... It is now unreferenced by any [policy]." No migration
-- since has re-added a call to it, and nothing in src/ calls it via .rpc(either) — every mention
-- left in the frontend is a code comment describing the OLD behavior it used to have, not an
-- actual call. Safe to drop: `cascade` is a no-op here since nothing depends on it, but kept for
-- safety in case something was missed.
begin;

drop function if exists public.task_visible(text, text, text) cascade;

commit;
