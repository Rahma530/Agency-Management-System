# Lifecycle and Permission Matrices

> Final approved implementation: drafts 001–004 enforce the rules below. Older comparison text is
> retained only as repository-lineage evidence.

| Action | Final server rule |
|---|---|
| Ordinary edit/status | `task_mutable_v2`: leadership, creator, current assignee (normalized with legacy fallback), managing AM, or matching service team lead. Marketing Manager visibility alone is not mutation authority. |
| Complete shared task | The first current assignee who records their own current-cycle evidence completes the task. The caller cannot name another employee. |
| Close | `task_closable`, current status `completed`, and a non-empty `done_link`. |
| Reopen | `task_closable`, explicit reason and target non-done state; increments cycle and preserves old completion records. |
| Archive/restore | Creator, current assignee, or Executive/Head of Technical/AI Engineer. Expected version and audit event required. |
| Active visibility | The sole `tasks_select_rls` policy requires `archived_at IS NULL`. |
| Historical visibility | `list_archived_tasks_v2` and SECURITY DEFINER report sources reuse `task_history_visible_v2`; archived rows do not re-enter active boards or capacity. |

## Confirmed current transition model

| From | To | Current UI/DB behavior |
|---|---|---|
| todo | in_progress, in_review, completed, blocked | Any actor able to update the visible task can currently perform it. |
| in_progress | todo, in_review, completed, blocked | Same broad update rule. |
| in_review | todo, in_progress, completed, blocked | Same broad update rule. |
| completed | closed | UI requires done link and creator/legacy-primary-assignee/admin. SQL requires only `task_closable`; no done-link or previous-state check. |
| completed | any non-done state | Allowed by broad UPDATE; browser clears `completed_at`. |
| blocked | any status | Allowed by broad UPDATE. Block reason is unstructured description text. |
| closed | any non-closed status | UPDATE policy permits it to any actor who can update/view the row; no dedicated reopen RPC. |

There is no distinct Done state. `completed` is completion; `closed` is manual close. There is no confirmed output-approval stage.

## Proposed transition model

| Action | Preconditions | Result and immutable evidence |
|---|---|---|
| Start | authorized participant; current todo/blocked where blocker resolved | status in_progress; event `status_changed`. |
| Send to review | authorized participant; in progress | status in_review; event. |
| Record individual completion | caller is assignee; evidence accepted | append `task_completion_events`; event `employee_completed`. Does not infer other assignees. |
| Complete task | approved business rule for shared tasks is satisfied | status completed; task-level `completed_at`; event references qualifying completion events. |
| Close | prior status completed; non-empty existing done_link; `task_closable` | status closed; event `closed`. No separate approval stage invented. |
| Reopen | authorized actor and reason | status selected non-done state; prior completion events retained; event `reopened`; task row may clear current-cycle completion marker only. |
| Block | authorized actor; reason required | status blocked plus structured active blocker; event. |
| Unblock | authorized actor; active blocker | blocker resolved; chosen prior/next status restored explicitly; event. |
| Archive/Delete | authorized actor; reason and optimistic version | soft-delete columns set; event; data retained. |
| Restore | authorized actor; optimistic version | soft-delete fields cleared; event. |

## Current effective permission evidence

`task_visible_v2` excludes Sales, then permits admins, creator, assignee, matching team leads, managing AM agent, limited Marketing Manager creative visibility, and parent-task inheritance. `tasks_update_rls` grants UPDATE to every actor matching the visibility/creator rule; only resulting `closed` status adds `task_closable`.

| Actor | View | Create | Edit/status | Reassign | Close | Delete |
|---|---|---|---|---|---|---|
| Executive / Head of Technical / AI Engineer | All tasks | Yes | All visible | Yes via RPC | Yes | No path |
| Creator, non-Sales | Own task | Yes | Own task | Yes via RPC | Yes | No path |
| Any assignee | Assigned task | Via general non-Sales create | Assigned task | Yes via RPC; creator cannot be removed | SQL: yes; UI may deny co-assignee | No path |
| Matching team lead | Team-derived visible tasks | Yes | Visible tasks | Yes via RPC | Only if creator/assignee/admin | No path |
| Managing AM agent | Client task | Yes | Visible client tasks | Yes via RPC | Only if creator/assignee/admin | No path |
| Marketing Manager | Creative-role tasks | Yes | RLS currently permits update of visible tasks | RPC deliberately denies reassignment | Only if creator/assignee | No path |
| UI/UX Designer | Assigned task | Non-Sales insert policy permits; UI may hide | RLS permits visible assigned task; UI restricts assignee management | UI/RPC restriction applies | SQL if assignee; UI legacy mismatch possible | No path |
| Sales | No task visibility | No | No | No | No | No |

## Proposed action authorization

All decisions below must be implemented in shared server predicates and reused by single, inline and bulk RPCs.

| Action | Proposed server rule |
|---|---|
| Create / multi-client create | Existing non-Sales creator rule plus server-resolved accessible-client snapshot. |
| View task/history | Reuse `task_visible_v2`, including soft-deleted visibility for prior authorized participants. |
| Edit title/description/priority/due date | Preserve current authorized set initially, but require optimistic version and audited RPC. Narrowing needs product approval. |
| Change client | Creator/admin only recommended; validate new client visibility and report consequences. |
| Assign/reassign | Reuse `set_task_assignees` authorization and escalation guards. |
| Individual complete | Current assignee only, using server identity. |
| Task-level complete | Dedicated transition RPC after approved shared-task rule. |
| Close | `task_closable`, current status completed, and non-empty done link, all enforced server-side. |
| Reopen | Creator/current assignee/admin recommended; explicit reason and expected version. |
| Block/unblock | `set_status` uses `task_mutable_v2`; entering blocked requires a bounded reason, records the prior status, and writes an immutable event. Leaving blocked selects an explicit non-done state and clears the current marker without erasing the event. |
| Duplicate | Same permission as create plus view source; never copy events/completion/daily links. |
| Archive/delete | Creator plus leadership is a proposed starting point; final role decision required. |
| Restore | Leadership-only recommended until ownership rules are approved. |
| Bulk actions | Per task, call the same predicate as the single action; no batch-level authorization shortcut. |
