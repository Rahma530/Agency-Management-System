-- Client subscriptions are four atomic services. "Comprehensive" is expanded by
-- the client before INSERT; historical Creative subscriptions belong to Social Media.
-- Keep existing rows and identifiers intact while moving their service classification.

alter table public.clients drop constraint clients_services_check;
alter table public.briefs drop constraint briefs_service_type_check;
alter table public.assignments drop constraint assignments_service_type_check;
alter table public.brief_field_schemas drop constraint brief_field_schemas_service_check;

update public.clients
set services = array_remove(array[
  case when 'seo' = any(services) then 'seo' end,
  case when 'social_media' = any(services) or 'creative' = any(services) then 'social_media' end,
  case when 'media_buying' = any(services) then 'media_buying' end,
  case when 'interface' = any(services) then 'interface' end
], null)
where 'creative' = any(services);

-- If a legacy design question has the same key as a Social Media question,
-- preserve its answers under the new schema key before reclassifying briefs.
do $$
declare question record;
begin
  for question in
    select legacy.id, legacy.key
    from public.brief_field_schemas as legacy
    where legacy.service_type = 'creative'
      and exists (
        select 1 from public.brief_field_schemas as social
        where social.service_type = 'social_media' and social.key = legacy.key
      )
  loop
    update public.briefs
    set fields = jsonb_set(fields, array['legacy_' || question.id], fields -> question.key, true)
    where service_type = 'creative' and fields ? question.key;
    update public.brief_revisions
    set fields = jsonb_set(fields, array['legacy_' || question.id], fields -> question.key, true)
    where service_type = 'creative' and fields ? question.key;
  end loop;
end $$;

update public.briefs set service_type = 'social_media' where service_type = 'creative';
update public.brief_revisions set service_type = 'social_media' where service_type = 'creative';
update public.assignments set service_type = 'social_media' where service_type = 'creative';

-- The schema has UNIQUE(service_type, key). Retain every legacy question; for a
-- custom question whose key already exists under Social Media, give its schema
-- a unique key while retaining its id and answers (copied above).
update public.brief_field_schemas as legacy
set key = 'legacy_' || legacy.id
where legacy.service_type = 'creative'
  and exists (
    select 1 from public.brief_field_schemas as social
    where social.service_type = 'social_media' and social.key = legacy.key
  );
update public.brief_field_schemas set service_type = 'social_media' where service_type = 'creative';

alter table public.clients add constraint clients_services_check
  check (services <@ array['seo', 'social_media', 'media_buying', 'interface']);
alter table public.briefs add constraint briefs_service_type_check
  check (service_type in ('seo', 'social_media', 'media_buying', 'interface'));
alter table public.brief_revisions add constraint brief_revisions_service_type_check
  check (service_type in ('seo', 'social_media', 'media_buying', 'interface'));
alter table public.assignments add constraint assignments_service_type_check
  check (service_type in ('seo', 'social_media', 'media_buying', 'interface'));
alter table public.brief_field_schemas add constraint brief_field_schemas_service_check
  check (service_type in ('seo', 'social_media', 'media_buying', 'interface'));

-- Interface briefs have their own questions. Graphic design/video questions
-- migrated above stay with Social Media; no separate design service remains.
insert into public.brief_field_schemas
  (id, service_type, key, label, type, placeholder, span, required, sort_order)
values
  ('bfs-ui-1', 'interface', 'project_scope', 'Interface / Product Scope', 'textarea', 'Which app, website, or interface needs design?', 'full', true, 0),
  ('bfs-ui-2', 'interface', 'target_users', 'Target Users', 'textarea', 'Who will use this interface?', 'full', true, 1),
  ('bfs-ui-3', 'interface', 'screens_flows', 'Screens & User Flows', 'textarea', 'List required screens and journeys.', 'full', false, 2),
  ('bfs-ui-4', 'interface', 'references', 'References / Existing Design', 'url', 'Link to existing product, Figma, or inspiration.', 'full', false, 3),
  ('bfs-ui-5', 'interface', 'design_assets', 'Brand Guidelines / Assets', 'url', 'Link to brand assets.', 'full', false, 4)
on conflict (service_type, key) do nothing;

-- Preserve a designer's access to their own historical briefs and assignments
-- after their service_type changes to Social Media. Do not grant access to all
-- Social Media briefs or to other clients.
create policy "briefs_select_designer_social" on public.briefs for select to authenticated
using (public.app_user_role() in ('graphic_designer', 'video_editor')
  and service_type = 'social_media' and submitted_by = public.app_user_id());
create policy "briefs_insert_designer_social" on public.briefs for insert to authenticated
with check (public.app_user_role() in ('graphic_designer', 'video_editor')
  and service_type = 'social_media' and submitted_by = public.app_user_id()
  and public.client_has_service(client_id, 'social_media'));
create policy "briefs_update_designer_social" on public.briefs for update to authenticated
using (public.app_user_role() in ('graphic_designer', 'video_editor')
  and service_type = 'social_media' and submitted_by = public.app_user_id())
with check (public.app_user_role() in ('graphic_designer', 'video_editor')
  and service_type = 'social_media' and submitted_by = public.app_user_id());
create policy "brief_revisions_select_designer_social" on public.brief_revisions for select to authenticated
using (public.app_user_role() in ('graphic_designer', 'video_editor')
  and service_type = 'social_media' and edited_by = public.app_user_id());
create policy "brief_revisions_insert_designer_social" on public.brief_revisions for insert to authenticated
with check (public.app_user_role() in ('graphic_designer', 'video_editor')
  and service_type = 'social_media' and edited_by = public.app_user_id()
  and public.client_has_service(client_id, 'social_media'));
create policy "assignments_select_designer_social" on public.assignments for select to authenticated
using (public.app_user_role() in ('graphic_designer', 'video_editor')
  and service_type = 'social_media' and agent_id = public.app_user_id());
