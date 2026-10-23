# Report Workspace SQL release runbook

Target Supabase project: `goxbgyjdgmvtjyaylgdu`

## Source status

- The base migration and its verification file are exact copies from `origin/main` at `c58b8bf270adf0cbf4a3cf3aa1eb175717cb72fe`.
- The hardening migration and its verification file are exact copies from PR #101 head commit `af6608bd238839f1695d644de3a5487ada792b6c`.
- At preparation time, PR #101 was **OPEN and not merged**. Do not treat the hardening SQL as released to `main` until GitHub confirms that merge independently.
- These release copies are for manual use. The original migration and verification files were not changed.

## Exact execution order

Use a separate SQL Editor run for each file. Do not combine the two migrations into one script.

1. `20261107000000_report_drafts_versions_audit.sql`
2. `20261107000000_report_drafts_versions_audit_tests.sql` — verification environment only
3. `20261107100000_report_workspace_release_hardening.sql`
4. `20261107100000_report_workspace_release_hardening_tests.sql` — verification environment only

For Production, run files **1 and 3 only**, in that order. Files 2 and 4 deliberately write test rows and should be run in a disposable/non-production database populated with suitable representative users and clients. They are included unchanged from the repository.

Do not use `supabase db push` for this manual release.

## Prerequisites

The target database must already contain all earlier repository migrations, particularly the canonical schema and the migrations that define:

- `public.users`, `public.clients`, `public.reports`, `public.daily_logs`, and `public.extra_notes`
- `public.app_user_id()`, `public.app_user_role()`, `public.direct_report_visible(text)`, `public.report_scope_accessible(text,text)`, and `public.comparison_scope_accessible(text)`
- `public.custom_roles` and `public.custom_role_modules`
- `public.ai_provider_state` and `public.ai_usage` from `20261024000000_ai_orchestrator_usage_tracking.sql` before `ai-router` is deployed
- `gen_random_uuid()` (normally supplied by the existing Supabase/Postgres extensions)

Safe read-only preflight:

```sql
select
  to_regclass('public.users') is not null as users_ok,
  to_regclass('public.clients') is not null as clients_ok,
  to_regclass('public.reports') is not null as reports_ok,
  to_regclass('public.daily_logs') is not null as daily_logs_ok,
  to_regclass('public.extra_notes') is not null as extra_notes_ok,
  to_regclass('public.custom_roles') is not null as custom_roles_ok,
  to_regclass('public.custom_role_modules') is not null as custom_role_modules_ok,
  to_regprocedure('public.app_user_id()') is not null as app_user_id_ok,
  to_regprocedure('public.app_user_role()') is not null as app_user_role_ok,
  to_regprocedure('public.direct_report_visible(text)') is not null as direct_report_visible_ok,
  to_regprocedure('public.report_scope_accessible(text,text)') is not null as report_scope_accessible_ok,
  to_regprocedure('public.comparison_scope_accessible(text)') is not null as comparison_scope_accessible_ok,
  to_regprocedure('gen_random_uuid()') is not null as gen_random_uuid_ok;
```

Every column should return `true` before file 1 is applied.

## Verification behavior and risks

### Base verification

`20261107000000_report_drafts_versions_audit_tests.sql` requires:

- one active authenticated `executive`
- one active authenticated `ai_engineer`
- one active authenticated `am_agent`
- one other active authenticated employee
- at least one client

It inserts fixed test IDs `verify-report-sat`, `verify-report-fri`, and `verify-report-note`, creates a report, versions, an AI suggestion, audit rows, and archives the report. Its final uncaught exception intentionally aborts the entire `DO` statement, so all test writes made by that statement are rolled back. An earlier uncaught failure also rolls back the statement.

Exact success signal (shown as an SQL error by design):

```text
TEST_OK_ROLLED_BACK: report scope, Friday exclusion, versioning, stale AI rejection, archive preservation, and AI Engineer restriction passed.
```

Production-data risks: a collision with any fixed test ID causes setup failure. The test expects exactly two collected sources for the selected agent and period `2026-10-10` through `2026-10-17`; existing daily logs or employee notes for that agent in that interval can cause a false failure. Run it as a standalone statement, not inside a transaction containing other work.

### Hardening verification

`20261107100000_report_workspace_release_hardening_tests.sql` requires:

- one active authenticated `executive`
- one active employee-report subject with a listed report-agent role
- one active authenticated employee with a listed no-Reports role
- at least one client

It creates a report and related version/source/audit rows through the RPCs. Its final uncaught exception intentionally rolls back all writes made by the `DO` statement.

Exact success signal (shown as an SQL error by design):

```text
TEST_OK_ROLLED_BACK: module gate, responsible identity, numeric grounding, and RPC-only updates passed.
```

Production-data risks: the mismatched-responsible test can be invalid if the arbitrary client's `am_agent_id` equals the selected executive. The numeric-grounding test can falsely fail if the chosen subject already has source text containing `999` in the test interval. Run it as a standalone statement in a disposable/non-production environment.

## Migration safety review

- Neither migration contains `DELETE`, `TRUNCATE`, or `DROP TABLE`, and neither performs permanent data deletion.
- The base migration adds columns, constraints, indexes, four report-workspace tables, RLS policies, and security-definer RPCs. It drops and recreates named constraints and policies as part of replacement.
- The base migration temporarily grants a limited set of direct `UPDATE` columns on `public.reports` to `authenticated` for legacy behavior.
- The hardening migration must follow promptly: it adds module/subject gates and content limits, replaces authorization-sensitive functions and policies, validates responsible identity and AI numeric grounding, revokes direct `UPDATE` on `public.reports`, and supplies a validated legacy-update RPC.
- The child workspace tables grant `SELECT` to `authenticated` under RLS; application writes are performed through RPCs, while `service_role` retains its intended backend access.
- Because file 3 references objects introduced by file 1, reversing the order will fail.

## Safe read-only checks after both migrations

Object and RPC presence:

```sql
select
  to_regclass('public.report_content_versions') is not null as versions_ok,
  to_regclass('public.report_source_items') is not null as sources_ok,
  to_regclass('public.report_ai_suggestions') is not null as suggestions_ok,
  to_regclass('public.report_audit_events') is not null as audit_ok,
  to_regprocedure('public.report_module_accessible()') is not null as module_gate_ok,
  to_regprocedure('public.report_subject_creatable(text,text,text)') is not null as subject_gate_ok,
  to_regprocedure('public.create_report_draft(text,text,text,text,date,date,text,text)') is not null as create_rpc_ok,
  to_regprocedure('public.save_report_version(text,text,text)') is not null as version_rpc_ok,
  to_regprocedure('public.archive_report(text,text,boolean)') is not null as archive_rpc_ok,
  to_regprocedure('public.approve_report(text)') is not null as approve_rpc_ok,
  to_regprocedure('public.create_report_ai_suggestion(text,text,text,text)') is not null as ai_create_rpc_ok,
  to_regprocedure('public.apply_report_ai_suggestion(text)') is not null as ai_apply_rpc_ok,
  to_regprocedure('public.update_legacy_report_draft(text,text,text,text,text)') is not null as legacy_update_rpc_ok;
```

RLS status:

```sql
select relname, relrowsecurity
from pg_class
where relnamespace = 'public'::regnamespace
  and relname in (
    'reports',
    'report_content_versions',
    'report_source_items',
    'report_ai_suggestions',
    'report_audit_events'
  )
order by relname;
```

All five rows must have `relrowsecurity = true`.

Direct-write privilege check:

```sql
select
  has_any_column_privilege('authenticated', 'public.reports', 'UPDATE') as reports_any_direct_update,
  has_table_privilege('authenticated', 'public.report_content_versions', 'INSERT,UPDATE,DELETE') as versions_direct_write,
  has_table_privilege('authenticated', 'public.report_source_items', 'INSERT,UPDATE,DELETE') as sources_direct_write,
  has_table_privilege('authenticated', 'public.report_ai_suggestions', 'INSERT,UPDATE,DELETE') as suggestions_direct_write,
  has_table_privilege('authenticated', 'public.report_audit_events', 'INSERT,UPDATE,DELETE') as audit_direct_write;
```

Every result must be `false` after file 3.

## Before deploying `ai-router`

Deploy only after both migrations have succeeded and the read-only checks above pass. Also confirm that the deployed function source contains hardening commit `af6608bd238839f1695d644de3a5487ada792b6c` or a later merged `main` containing it.

Run this additional read-only pre-deployment check; every result must be `true`:

```sql
select
  to_regclass('public.ai_provider_state') is not null as provider_state_ok,
  to_regclass('public.ai_usage') is not null as usage_log_ok,
  to_regclass('public.report_content_versions') is not null as report_versions_ok,
  to_regprocedure('public.report_row_editable(text)') is not null as report_edit_gate_ok;
```

Deployment requirements (names only; do not paste secret values into SQL or this file):

- Supabase target: `goxbgyjdgmvtjyaylgdu`
- JWT verification enabled (`verify_jwt = true`)
- `AI_ROUTER_ENABLED`
- `AI_ROUTER_ALLOWED_ORIGIN` (must include the real production origin, including `https://kms.kesraa.com` where applicable)
- `GEMINI_API_KEY`, `GEMINI_MODEL`
- `GROQ_API_KEY`, `GROQ_MODEL`
- `OPENROUTER_API_KEY`, `OPENROUTER_MODEL`
- `CAMPAIGN_SUMMARY_ANALYZE_ORDER`
- `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`
- Optional: `GROQ_REASONING_EFFORT`

Deployment command for the operator to run later (not executed while preparing this package):

```text
supabase functions deploy ai-router --project-ref goxbgyjdgmvtjyaylgdu --use-api
```

After deployment, validate an authenticated request from the production origin and inspect the function logs without exposing request bodies or secrets.
