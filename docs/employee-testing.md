# Temporary real employee testing login

This workflow uses the normal employee Email + Password login. The tester's admin
session is signed out before the employee signs in; no admin token is stored for
restoration. The only browser session marker contains the selected public user
ID, Auth user ID, and login email. It controls the visible testing banner, not
authentication or RLS.

## Enable account setup

Deploy `supabase/functions/employee-test-account` to the application's original
Supabase project (`goxbgyjdgmvtjyaylgdu`) with JWT verification enabled
(declared in `supabase/config.toml`). Configure **server-side** Edge Function
secrets `EMPLOYEE_TEST_ACCOUNT_SETUP_ENABLED=true` and
`EMPLOYEE_TEST_ALLOWED_ORIGIN` to the exact app origin (for example,
`http://localhost:3000` locally or the HTTPS deployment origin). The Function
also requires `EMPLOYEE_TEST_PROTECTED_TOQA_AUTH_ID` and
`EMPLOYEE_TEST_PROTECTED_SHAHD_AUTH_ID` to contain their **distinct, verified**
`auth.users.id` values from that same project. Set these server-side only.
Until both IDs are configured, the Function refuses every request to generate
a password for a linked account. Status checks and the existing unlinked
account setup path remain available. Never use names or the sample users in
`initialData.ts` to determine these IDs.

The Function
uses the Supabase-provided `SUPABASE_URL`, `SUPABASE_ANON_KEY`, and
`SUPABASE_SERVICE_ROLE_KEY` server environment variables. Never use a `VITE_`
prefix for the service-role key.

The frontend is enabled automatically in Vite development. For a production
build used for testing, set `VITE_ENABLE_EMPLOYEE_TESTING_MODE=true` at build
time and redeploy. Both switches default to off in production. Disable the
server switch and remove the frontend flag after testing; neither switch is an
authorization boundary. The Function verifies the caller's JWT and the linked
active Executive/Head of Technical row on each request.

## Use

1. Sign in as an Executive or Head of Technical with a real Supabase Auth account.
2. Open Employee Testing / Account Setup and select a non-disabled employee from
   the live `public.users` directory. Pending employees without `auth_id` are
   included. Disabled employees are excluded.
3. An existing linked Auth account is reported as ready. Selecting it never
   changes its password. For accounts other than the two protected employees,
   **Generate Temporary Test Password** explicitly changes the existing Auth
   password and displays the new random password once. It is not the
   employee's permanent password. Toqa and Shahd must use their existing
   password or normal setup link; their passwords cannot be changed here. If
   the Auth email differs from `public.users.email`, use the Auth email shown.
4. For an unlinked employee whose email is unused in Auth, choose a temporary
   password. The server creates an actual Auth user, confirms the email for
   testing, and links its ID to the existing `public.users` row. It never
   writes the password to `public.users`. Conflicting preexisting Auth accounts
   are refused for manual review.
5. Select **Start Employee Test Session**. The admin session is signed out.
   Enter the employee Auth email and password in the existing login screen.
6. The banner appears only after `auth.getUser()` matches the employee's
   `auth_id` and `app_user_id()` returns that employee's public ID under RLS.
   **Exit Testing Session** signs out the employee. Sign in again as the admin
   to return; admin tokens are not retained in custom storage.

Generated passwords are returned only to the authorized caller in the successful
Function response. They are not logged, saved in `public.users`, or persisted
by the app; refreshing or closing the selector clears the displayed value.
The temporary password has no automatic expiry in Supabase Auth. When testing
ends, the employee should set their own password through the existing setup or
reset link. The `auth_id` linkage remains the ordinary production linkage; do
not delete the employee or Auth account merely to remove Testing Mode.

## Runtime verification

With a test employee signed in, check `supabase.auth.getUser()` (the app's
development console exposes `window.supabase`) and verify the returned Auth ID
matches the employee's linked `public.users.auth_id`. Calling
`supabase.rpc('app_user_id')` must return the employee's public ID. Check a
client/task row visible only to that employee, and confirm chat messages,
notifications, and unread counts are scoped to the employee. The app cannot
prove these live results without an actual deployed Function, linked Auth user,
employee credentials, and access to that Supabase project.
