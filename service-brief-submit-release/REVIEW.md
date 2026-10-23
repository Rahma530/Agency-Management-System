# Service Brief Submit — Emergency Repair Review

Status: **prepared only; not executed**.

## Final release files (supersedes earlier candidates)

- `20261014150000_service_brief_submit_release.sql` is the single final migration.
- `20261014151000_service_brief_historical_visibility_restoration_TEMPLATE.sql` is a separate,
  deliberately non-runnable restoration template and is not part of the automatic migration.
- `service-brief-submit-frontend-release.patch` is the single final frontend patch and exactly
  matches all frontend/TypeScript working-tree changes listed below.
- Earlier `1100` through `1410` candidates and earlier patch files remain preserved and must not be
  included alongside `1500` in the eventual migration sequence.

### Final UI/UX Designer behavior

- The release registers the built-in role `ui_ux_designer`, displayed as `UI/UX Designer`, under
  department `CREATIVE`, team `Creative & Design`, and service `interface`. It deliberately does
  not reinterpret `graphic_designer` or `video_editor` as UI/UX roles.
- Leadership (Executive, Head of Technical, and AI Engineer) can use the existing Client Dashboard
  assignment UI to assign an active UI/UX Designer to a subscribed `interface` client. The INSERT
  policy validates the exact service, active employee, and exact role.
- UI/UX Designer can read only their own `assignments(service_type = 'interface')`, the matching
  client, and a matching `interface` brief after `submitted_at IS NOT NULL`. The routing view now
  requires the assignment's `service_type` to match, eliminating the old any-service UI leak.
- Brief INSERT/UPDATE policies are unchanged for this role: it cannot create, submit, or edit a
  brief. `mark_brief_viewed(text)`, Portal policies, and existing Graphic Designer/Video Editor
  policies remain unchanged.
- Task access is assigned-only. Restrictive RLS prevents task creation and visibility/update of an
  unassigned task. Guard triggers allow only status, completion/delivery, hours, and viewed-time
  fields, and prevent task-assignee list changes. The frontend hides Create/Edit/Add Subtask and
  assignee controls while retaining status and delivery actions.
- `users_role_valid_guard()` is updated in place; no enum or static role CHECK exists in the current
  schema lineage. Employee creation automatically lists the role through `AGENCY_ROLES`.

### Historical rows

- `brf-5154` (`media_buying`) and `brf-8417` (`interface`) are not modified by the release. The
  repository contains no trusted evidence proving either was submitted, so both remain
  unpublished when their `submitted_at` is NULL.
- The `1510` restoration template remains a separate, intentionally non-runnable business-approval
  tool. It must never be applied based on row existence, row count, or created/updated timestamps.

### Current verification and deployment order

- Static TypeScript/security lint: PASS.
- Production build: PASS outside the filesystem sandbox; 2,074 modules transformed. The existing
  large-chunk advisory is non-blocking.
- `git diff --check`: PASS.
- PostgreSQL runtime validation: NOT RUN. No database was contacted.
- Deploy in this order: (1) apply only `20261014150000_service_brief_submit_release.sql` in a
  controlled low-traffic window, (2) verify the schema reload and role/RLS matrix with real test
  sessions, (3) merge/deploy the frontend patch, (4) verify a real Draft -> Submit -> assigned-team
  visibility flow, and only then consider a business-approved copy of the historical template.
- Rollback: any pre-commit assertion/timeout rolls back automatically. After commit, restore the
  captured prior policy definitions in a separately reviewed transaction; do not drop
  `submitted_at` or blanket-publish rows. The frontend patch can be reverted normally.

## Archived candidate history (not part of the release)

## Final end-to-end release set

- `20261014140000_service_brief_submit_end_to_end_release_candidate.sql` is the final main SQL
  candidate. It preserves every earlier candidate, validates PostgreSQL restrictive-policy support,
  validates all named authorization functions (including the legacy any-service helper), checks
  EXECUTE privileges for every function used by the final policies, and verifies the preserved
  Designer and Portal scopes before changing anything.
- `20261014141000_service_brief_historical_visibility_restoration_TEMPLATE.sql` is the final
  historical-restoration template. Every row requires an approved ID, expected service type,
  approved timestamp, and evidence reference; the transaction aborts on an empty list, missing ID,
  service mismatch, or already-classified row.
- `service-brief-submit-frontend-final.patch` is the exact isolated frontend diff. It has been
  applied to the local working copy of `src/App.tsx`; the patch reverse-check succeeds, proving the
  working change matches the delivered patch.
- No Production SQL, deployment, commit, push, or PR operation was performed.

## Deliverable

- `20261014110000_service_brief_submit_emergency_repair.sql` remains preserved as the earlier
  proposal.
- `20261014120000_service_brief_submit_release_candidate.sql` remains preserved as the preceding
  static-review candidate. It is a separate file and was not replaced or edited.
- The release candidate adds an explicit preflight for the five expected policies and verifies that
  the preserved Designer/Portal policies are permissive authenticated SELECT policies before DDL.
- `20261014130000_service_brief_submit_final_candidate.sql` is the focused final candidate. It adds
  `briefs_submission_gate_rls` as a restrictive SELECT gate so service-team employees cannot use an
  unrelated permissive policy to read an unsubmitted row. Portal-only identities and the existing
  Designer/AM/leadership scopes remain controlled by their existing permissive policies.
- `20261014131000_service_brief_historical_visibility_restoration_TEMPLATE.sql` is deliberately
  non-runnable until exact business-approved IDs, timestamps, and evidence references are inserted.
- `service-brief-submit-frontend.patch` contains the separate proposed `src/App.tsx` hardening. It
  requires the UPDATE to return exactly one persisted row before local state or notifications report
  success. It remains preserved as the preceding patch; the equivalent final patch is now applied
  locally as documented above.

## Evidence reviewed

The following migrations were read in full:

1. `supabase/migrations/20261013100000_service_brief_view_only_for_departments.sql`
   - Removes broad Service Team write policies.
   - Creates `mark_brief_viewed(text)` as the only narrow Team Lead write path.
2. `supabase/migrations/20261014100000_brief_submitted_at_visibility.sql`
   - Adds nullable `submitted_at`, backfills historical rows, and gates the service-team SELECT
     branches on publication.
3. `supabase/migrations/20261018000000_align_ai_engineer_with_head_of_technical.sql`
   - Replaces the briefs SELECT/INSERT/UPDATE policies and adds `ai_engineer` wherever
     `head_of_technical` is authorized.
4. `supabase/migrations/20261020000000_leadership_brief_write_access.sql`
   - Supplies the final INSERT policy for first-time brief creation and the final revision INSERT
     policy. The emergency proposal reuses only its final `briefs_write_rls` rule and does not touch
     revision history policies.

The frontend path was also checked:

- `src/components/DynamicBriefForm.tsx` exposes Submit only for an existing, unsubmitted brief and
  keeps a failed error visible.
- `src/components/ClientDashboard.tsx` and `src/components/ServiceBriefsRoutingView.tsx` pass the
  same `canEditServiceBrief` authorization gate to Submit.
- `src/App.tsx` updates only `submitted_at` during Submit. Local state and notifications happen
  only after Supabase accepts the update.
- Normal draft save/update does not populate or clear `submitted_at`, so publication remains a
  one-way explicit action.

## Policy comparison

- `SELECT`: the publication gate, leadership/AM branches, and `ai_engineer` parity follow
  `20261018000000_align_ai_engineer_with_head_of_technical.sql`. The six confirmed Agent roles are
  retained, but the overly broad `agent_assigned_any_service(client_id)` branch is replaced by the
  repository's established service mapping: SEO roles require the SEO brief and SEO assignment,
  Media Buying requires the Media Buying brief and assignment, and Social Media requires the
  Social Media brief and assignment. Every service-team branch also requires publication.
- `UPDATE`: copied without role expansion from the final 20261018 definition. Only
  Executive/Head of Technical/AI Engineer/AM Team Lead, the assigned AM Agent, and the owning
  Creative author match it. Service Team Leads and service Agents remain excluded.
- `INSERT`: copied without role expansion from
  `20261020000000_leadership_brief_write_access.sql`. It requires `submitted_by = app_user_id()`
  and permits only leadership/AM scope or a Creative author creating a Creative brief.

## Proposed behavior

- The repository and Preflight prove that two rows exist, but they do not prove either row's
  historical publication state. Row count and non-NULL `created_at`/`updated_at` values are not
  publication evidence, so the proposal performs no historical backfill.
- On first application, every existing row is preserved byte-for-byte in its existing columns and
  receives `submitted_at = NULL` through PostgreSQL's normal nullable-column behavior. Those rows
  are treated as drafts until an authorized user explicitly publishes them after identifying them.
- A new nullable `timestamptz` column has no default, so newly inserted drafts remain `NULL`.
- Re-running the file after the column exists leaves all existing `submitted_at` values unchanged.
- The final SELECT policy includes `ai_engineer` parity with `head_of_technical` and preserves the
  six roles confirmed in the current Production policy: `seo_agent`, `seo_content_agent`,
  `seo_backlink_agent`, `store_manager`, `media_buying_agent`, and `social_media_agent`. It also
  restores the role-to-service checks found throughout the schema and UI. This narrows the broad
  any-service condition; it does not grant a role access to a new service.
- The final UPDATE and INSERT policies preserve the Service Team view-only boundary from 20261013
  and leadership creation rights from 20261020.
- `mark_brief_viewed(text)` is verified and preserved, not replaced.
- No table or column `GRANT`/`REVOKE` is included. The verified table-level UPDATE privilege
  automatically covers a later-added column; the SQL asserts effective UPDATE on `submitted_at`
  and rolls back if that assumption is no longer true. The only new privilege statements revoke
  PUBLIC execution of the three trigger-only guard functions, preventing direct RPC invocation.

## Re-run and concurrency safety

- The earlier proposal held an explicit `ACCESS EXCLUSIVE` lock from before dependency validation
  until commit. That lock blocks reads and writes and could cause a visible Production interruption
  for the full transaction, even though adding a nullable/no-default column needs no data rewrite.
- The explicit long-lived lock has therefore been removed. PostgreSQL still takes the lock required
  by each `ALTER TABLE`/policy DDL statement. In particular, `ALTER TABLE ... ADD COLUMN` acquires
  `ACCESS EXCLUSIVE`, and PostgreSQL retains that lock until `COMMIT`; reads and writes can therefore
  be blocked during the remaining policy DDL at the end of the transaction. Because validation now
  happens before the `ALTER`, this blocking window is shorter than with the former explicit lock.
- `lock_timeout = '5s'` limits how long lock acquisition may wait under traffic; it does not limit
  how long an acquired lock is retained. `statement_timeout = '60s'` remains as a per-statement
  safety bound. A lock-timeout failure rolls the transaction back and should be retried only in a
  controlled low-traffic window.
- There is no backfill race to protect: adding the nullable/no-default column assigns `NULL` to all
  existing rows, and the transaction makes the column plus policy replacement visible atomically.
- All dependencies and effective privileges are checked before policy replacement.
- An incompatible pre-existing column, missing dependency, disabled RLS, or failed final assertion
  aborts and rolls back the transaction.
- If `submitted_at` already exists, historical NULL rows still cannot be distinguished from genuine
  post-release drafts using repository evidence alone. The proposal leaves every value unchanged.

## Post-application verification

### Schema and data

1. Confirm `public.briefs.submitted_at` is nullable `timestamptz` with no default.
2. If the column was absent before the repair, confirm every pre-existing row has
   `submitted_at IS NULL`. If the column already existed, confirm the release left all of its values
   unchanged. Publish a historical row only after its identity and prior publication state are
   independently verified.
3. Confirm PostgREST can select `submitted_at` without a schema-cache error.
4. Confirm all six required briefs policies exist, including the new restrictive
   `briefs_submission_gate_rls`, and inspect their `qual`/`with_check` definitions and
   permissive/restrictive kinds.
5. Confirm `authenticated` retains effective SELECT, INSERT, and UPDATE, including UPDATE on
   `submitted_at`.
6. Confirm `mark_brief_viewed(text)` still exists and is executable by `authenticated`.
7. Confirm `briefs_select_designer_social` still exists unchanged; together with the other four
   named policies the proposal now asserts five required SELECT/UPDATE/INSERT policies.

### Application behavior

1. Create a new brief through the normal Save flow and confirm `submitted_at IS NULL`.
2. As a service Team Lead and assigned service Agent, confirm that draft is not selectable before
   publication. Test SEO Team Lead plus `seo_agent`, `seo_content_agent`, `seo_backlink_agent`, and
   `store_manager`; then test Media Buying and Social Media Team Lead/Agent branches separately.
3. As an authorized AM/leadership user, press Submit and confirm `submitted_at` becomes non-NULL.
4. Compare the row before/after Submit and confirm `fields`, `custom_field_defs`, `version`,
   `submitted_by`, `created_at`, and `team_lead_viewed_at` did not change.
5. Confirm Executive, Head of Technical, AI Engineer, AM Team Lead, and the assigned AM can see the
   published brief according to their existing row scope.
6. Confirm the relevant service Team Lead and Agent can see the published brief.
7. Attempt direct content updates as SEO/Media Buying/Social Media Team Lead and Agent; RLS must
   reject edits to `fields`, `version`, and other brief content.
8. Call `mark_brief_viewed(text)` as the matching Team Lead and confirm only
   `team_lead_viewed_at` changes.
9. Repeat Submit on the already-published UI state: the button should no longer be offered and the
   timestamp should remain unchanged.
10. With the applied `service-brief-submit-frontend-final.patch`, force an UPDATE that RLS filters
    to zero rows. Confirm Submit reports a persistent error and neither local state nor notifications
    claim publication. On a permitted Submit, confirm the UI uses the exact `submitted_at` returned
    by PostgreSQL.

### Historical publication recovery after this release

1. Inventory the real Production rows read-only and record each stable `briefs.id`.
2. For each ID, require an independent trusted source that proves prior publication; row count,
   `created_at`, `updated_at`, `version`, field completeness, and revision existence are not proof.
3. Put only proven IDs and their approved publication timestamps into a separate reviewed recovery
   transaction. Do not add that data update to this schema/RLS release candidate.
4. Require every targeted ID to exist and still have `submitted_at IS NULL`; abort the whole
   recovery transaction on a missing, duplicate, or already-classified row.
5. Return and compare the exact affected IDs, then verify that content, `version`, revisions, and
   unrelated rows did not change.
6. Leave every row without evidence at `submitted_at IS NULL` and use the normal authorized Submit
   workflow if the business later decides to publish it.

## Separate behavior intentionally preserved

### Service-scoped Agent visibility

- Policy: `briefs_select_rls`.
- The final candidate removes the cross-service effect of `agent_assigned_any_service(client_id)`
  for Brief SELECT. It uses the existing `agent_assigned(client_id, service)` function plus the
  established role mapping in `src/lib/serviceAssignment.ts` and the earlier service-scoped RLS.
- This means an SEO-family Agent sees only submitted SEO Briefs for their SEO assignments; Media
  Buying and Social Media Agents receive the equivalent service-specific behavior.

### Client Portal draft visibility

- Policy: `briefs_select_portal_rls`.
- Source: client-portal/canonical schema migrations.
- It does not require `submitted_at IS NOT NULL`. The final candidate preserves that product scope:
  a portal-only identity passes the restrictive gate and the unchanged Portal policy still limits
  rows by `client_id = portal_client_id()`. An employee identity does not get this bypass merely by
  also having a Portal record, because the restrictive policy evaluates the employee role first.

### Permissive SELECT-policy composition

- PostgreSQL combines applicable permissive policies with `OR`; satisfying any SELECT policy is
  enough within the permissive set. The new restrictive `briefs_submission_gate_rls` is then
  combined with that permissive result using `AND`.
- `briefs_select_designer_social`, created by
  `20261008100000_client_services_model.sql`, permits a `graphic_designer` or `video_editor` to read
  their own `social_media` brief without checking `submitted_at`. It can therefore expose that
  caller's own draft. This is narrow to `submitted_by = app_user_id()` and is paired with existing
  INSERT/UPDATE policies for the same owner; it does not expose the draft to SEO, Media Buying, or
  Social Media Agent roles. The emergency proposal preserves it unchanged.
- The main `briefs_select_rls` also intentionally lets a `graphic_designer`/`video_editor` read
  their own `creative` row without a publication check, so its author can continue editing a draft.
- `briefs_select_portal_rls`, originating in `20260913100000_client_portal.sql` and repeated by the
  canonical migrations, uses only `client_id = portal_client_id()`. It can therefore expose every
  brief for that portal client, including an unsubmitted draft, to a portal-only identity. Per the
  explicit scope restriction, this proposal does not change it. The restrictive gate prevents an
  employee service-team identity from using that permissive policy to evade publication gating.

## Unresolved assumptions and risks

- Repository evidence cannot reconstruct historical manual SQL activity; this proposal targets
  the current schema state proven by Preflight.
- Existing rows become hidden from service-team branches that require publication until an
  authorized user explicitly submits them. This availability change is the safe consequence of
  refusing to infer publication from timestamps or row count.
- A later manual publication decision must identify rows by a stable ID and establish their prior
  publication state from a trusted source; this proposal deliberately provides no blanket UPDATE.
- No live role-based test has been run. Readiness requires the post-application tests above using
  authorized test accounts and real RLS sessions.
- The original `src/App.tsx` checked only the Supabase error, so a policy-filtered zero-row UPDATE
  could look successful. The local working copy now requests `id, submitted_at` with `.single()`,
  verifies both values, and uses the persisted timestamp. The delivered final patch exactly matches
  that change. Runtime behavior still requires the manual RLS-session test described above.
- The proposal received static repository review only. It was not parsed or executed by a live
  PostgreSQL/Supabase runtime, in accordance with the no-SQL-execution restriction.
- Because the Portal and designer-owner policies remain permissive and lack a publication gate,
  this proposal must not be represented as enforcing "all drafts are AM/leadership-only." This is
  not a blocker to the narrowly scoped schema-cache/Service Team visibility repair if that existing
  behavior is accepted, but it requires a separate product/RLS decision before claiming global
  draft confidentiality.

## Local verification results

- `npm run lint`: PASS. TypeScript and every embedded client/report/security check completed.
- `npm run build`: PASS when rerun outside the filesystem sandbox. The first attempt was blocked by
  a sandbox `EPERM` on `realpath(src/main.tsx)`; the authorized rerun built 2,074 modules. Vite
  reported only its existing large-chunk advisory.
- `git diff --check`: PASS.
- `git apply --reverse --check -- service-brief-submit-release/service-brief-submit-frontend-final.patch`:
  PASS, confirming the local `src/App.tsx` edit matches the standalone patch.
- Static main-SQL assertions: PASS; no data backfill or data UPDATE/INSERT/DELETE exists. No table
  or column privilege is changed; only PUBLIC EXECUTE on trigger-only guard functions is revoked.
- Static restoration-template guards: PASS for explicit service, empty list, missing ID,
  future timestamp, already-classified row, and exact affected-row count.
- PostgreSQL runtime validation: NOT RUN. No local disposable PostgreSQL/Supabase database was
  available or authorized, and no external database was contacted.

## Final verification run

- `npm run lint`: PASS after the final interface-policy candidate and frontend change.
- `npm run build`: PASS; Vite transformed 2,074 modules. The large-chunk message is advisory.
- `git diff --check`: PASS.
- Final frontend patch reverse-check: PASS.
- Main migration static check: PASS; it contains no data backfill or data UPDATE/INSERT/DELETE and
  no table/column privilege change. PostgreSQL runtime execution remains NOT RUN.

## Deployment order

1. Capture the current five policy definitions and the current `submitted_at` schema/value state
   read-only for rollback evidence.
2. Run only `20261014150000_service_brief_submit_release.sql` in a controlled low-traffic window.
3. Verify the transaction committed, PostgREST recognizes `submitted_at`, policies have their
   expected permissive/restrictive kinds, and Draft/Submit role tests pass.
4. Obtain independently approved historical IDs, service types, timestamps, and evidence. Edit a
   reviewed copy of `20261014151000_service_brief_historical_visibility_restoration_TEMPLATE.sql`;
   never run the empty template or infer publication from row count/timestamps.
5. Apply `service-brief-submit-frontend-release.patch`, run lint/build, review, merge, and deploy
   through the normal frontend release workflow.
6. Verify a real authorized Submit, zero-row failure handling, and service-specific visibility.
7. For interface, verify an explicit `assignments(service_type='interface')` row belonging to the
   business-approved UI employee before expecting visibility. Do not create it implicitly.

## Rollback guidance

- Any assertion, lock timeout, or DDL failure before `COMMIT` rolls back the entire migration
  automatically.
- After a successful commit, do not drop `submitted_at`: it may contain legitimate submissions and
  dropping it would destroy publication evidence.
- For an RLS regression, use a separately reviewed transaction to restore the exact policy
  definitions captured in deployment step 1, then reload PostgREST. Do not blanket-publish rows and
  do not remove the restrictive gate without simultaneously restoring a publication-safe policy set.
- Historical restoration is separately transactional. Any missing ID, service mismatch,
  future timestamp, already-classified row, or affected-row mismatch aborts all restoration rows.
- Frontend rollback is the ordinary reversal of `service-brief-submit-frontend-release.patch`.
  Keeping the hardened frontend is safer because the old code can report success after a zero-row
  UPDATE; revert it only if a verified compatibility problem requires it.
