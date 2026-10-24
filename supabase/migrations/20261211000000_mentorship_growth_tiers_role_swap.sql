-- Owner correction: "احنا اتفقنا AI ملوش صلاحيات دلوقتي - الجزء ده خاص بـ MB TL - Executive /
-- Head of Technical" — mentorship_growth_tiers_write_rls/_update_rls (20261204000000) were
-- written as (executive, head_of_technical, ai_engineer); ai_engineer should never have had write
-- access here (consistent with 20261124000000_ai_engineer_deprivilege.sql's broader removal of
-- ai_engineer's standing write privileges elsewhere in this schema), and media_buying_team_lead —
-- who actually runs the Mentorship Tracker day to day — should have had it instead.
begin;

drop policy if exists "mentorship_growth_tiers_write_rls" on public.mentorship_growth_tiers;
create policy "mentorship_growth_tiers_write_rls" on public.mentorship_growth_tiers
for insert to authenticated
with check (public.app_user_role() in ('executive', 'head_of_technical', 'media_buying_team_lead'));

drop policy if exists "mentorship_growth_tiers_update_rls" on public.mentorship_growth_tiers;
create policy "mentorship_growth_tiers_update_rls" on public.mentorship_growth_tiers
for update to authenticated
using (public.app_user_role() in ('executive', 'head_of_technical', 'media_buying_team_lead'))
with check (public.app_user_role() in ('executive', 'head_of_technical', 'media_buying_team_lead'));

commit;
