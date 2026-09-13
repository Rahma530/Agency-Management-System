-- ============================================================================
-- Module 9 (AI Layer), point 5: meeting recording/transcript scaffolding.
-- ============================================================================
-- meetings had SELECT only before this migration (meetings_select_rls from 20260906120000, plus
-- `grant select` from 20260907090000) — no insert/update grant or policy existed at all. This adds
-- both, mirroring meetings_select_rls's exact audience: Executive/Head of Technical/AM Team Lead
-- unrestricted, an AM Agent only for their own assigned clients (client_am_agent_is_caller, the
-- same helper client_portal_users_insert_staff_rls already uses for the equivalent AM-staff
-- pattern in Module 8).
--
-- No real transcription/summarization exists yet (Module 9 has no AI API access) — this is
-- upload + manual entry scaffolding only. recording_url stores the private Storage path (not a
-- public URL); transcript_text/ai_summary_text are plain manually-typed text for now, explicitly
-- labeled as such in the UI (ClientMeetingsPanel.tsx).
--
-- Storage bucket 'meeting-recordings': private, object path convention
-- "{client_id}/{meeting_id}-{sanitized filename}" (same convention as task-attachments —
-- see src/lib/supabase.ts's buildMeetingRecordingStoragePath), so
-- (storage.foldername(name))[1] reliably yields the client_id.
-- ============================================================================

begin;

grant insert, update on public.meetings to authenticated;

create policy "meetings_insert_rls" on public.meetings
for insert
to authenticated
with check (
  public.app_user_role() in ('executive', 'head_of_technical', 'am_team_lead')
  or (public.app_user_role() = 'am_agent' and am_agent_id = public.app_user_id() and public.client_am_agent_is_caller(client_id))
);

create policy "meetings_update_rls" on public.meetings
for update
to authenticated
using (
  public.app_user_role() in ('executive', 'head_of_technical', 'am_team_lead')
  or (public.app_user_role() = 'am_agent' and am_agent_id = public.app_user_id())
)
with check (
  public.app_user_role() in ('executive', 'head_of_technical', 'am_team_lead')
  or (public.app_user_role() = 'am_agent' and am_agent_id = public.app_user_id())
);

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'meeting-recordings',
  'meeting-recordings',
  false,
  209715200, -- 200MB — recordings run larger than task-attachments' 50MB cap
  array[
    'video/mp4', 'video/quicktime', 'video/webm', 'video/x-m4v',
    'audio/mpeg', 'audio/mp4', 'audio/wav', 'audio/webm', 'audio/x-m4a'
  ]
)
on conflict (id) do update set
  public = excluded.public,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

create policy "meeting_recordings_objects_select_rls" on storage.objects
for select
to authenticated
using (
  bucket_id = 'meeting-recordings'
  and (
    public.app_user_role() in ('executive', 'head_of_technical', 'am_team_lead')
    or public.client_am_agent_is_caller((storage.foldername(name))[1])
  )
);

create policy "meeting_recordings_objects_insert_rls" on storage.objects
for insert
to authenticated
with check (
  bucket_id = 'meeting-recordings'
  and (
    public.app_user_role() in ('executive', 'head_of_technical', 'am_team_lead')
    or public.client_am_agent_is_caller((storage.foldername(name))[1])
  )
);

commit;
