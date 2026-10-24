-- Rollback for 20261211000000_mentorship_growth_tiers_role_swap.sql
-- Restores the original (executive, head_of_technical, ai_engineer) write/update policies.
begin;

drop policy if exists "mentorship_growth_tiers_write_rls" on public.mentorship_growth_tiers;
create policy "mentorship_growth_tiers_write_rls" on public.mentorship_growth_tiers
for insert to authenticated
with check (public.app_user_role() in ('executive', 'head_of_technical', 'ai_engineer'));

drop policy if exists "mentorship_growth_tiers_update_rls" on public.mentorship_growth_tiers;
create policy "mentorship_growth_tiers_update_rls" on public.mentorship_growth_tiers
for update to authenticated
using (public.app_user_role() in ('executive', 'head_of_technical', 'ai_engineer'))
with check (public.app_user_role() in ('executive', 'head_of_technical', 'ai_engineer'));

commit;
