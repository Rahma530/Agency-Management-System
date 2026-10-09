# Hostinger production deployment

This application is a static Vite build and uses hash-based navigation, so it can be hosted from the root of a Hostinger domain without server-side routing.

## 1. Choose the final origin

Use the exact HTTPS origin only, with no path or trailing slash:

```text
https://YOUR-HOSTINGER-DOMAIN
```

Do not use `system.kesraa.com` unless that domain has explicitly been reassigned to this application.

## 2. Build-time environment variables

Set these before running the production build:

```text
VITE_SUPABASE_URL=https://goxbgyjdgmvtjyaylgdu.supabase.co
VITE_SUPABASE_ANON_KEY=YOUR_PUBLIC_ANON_KEY
VITE_ENABLE_DEMO_LOGIN=false
VITE_ENABLE_EMPLOYEE_TESTING_MODE=true
```

Never expose `SUPABASE_SERVICE_ROLE_KEY` as a `VITE_` variable or upload it to Hostinger.

## 3. Build and upload

```text
npm install
npm run lint
npm run build
```

Upload the contents of `dist/` (not the `dist` directory itself) to the domain's `public_html` directory. Confirm that HTTPS is active before testing authentication.

## 4. Supabase Auth URL Configuration

In Supabase Dashboard -> Authentication -> URL Configuration:

- Set **Site URL** to `https://YOUR-HOSTINGER-DOMAIN`.
- Add `https://YOUR-HOSTINGER-DOMAIN` to **Redirect URLs**.
- Keep the Vercel production origin temporarily during migration if both deployments must work.
- Keep `http://localhost:3000` only if local password recovery is still needed.

The Reset Password email template should link through `{{ .ConfirmationURL }}` so Supabase preserves the requested `redirect_to` value.

## 5. Employee Testing origin

If Employee Testing remains enabled, update the Supabase Edge Function secret so the Hostinger origin is allowed:

```text
EMPLOYEE_TEST_ALLOWED_ORIGIN=http://localhost:3000,https://agency-management-system-alpha.vercel.app,https://YOUR-HOSTINGER-DOMAIN
```

Remove origins only after their deployments are retired.

## 6. Manually generated recovery links

Before running `provisionAuthUsers.ts`, `resendRecoveryLink.ts`, or `getRecoveryLink.ts`, set:

```text
AUTH_REDIRECT_URL=https://YOUR-HOSTINGER-DOMAIN
```

The scripts now fail safely when this value is missing instead of silently generating a localhost or stale-domain link.

## 7. Production verification

Use one dedicated test employee and verify this complete sequence:

1. Request or generate a fresh recovery link.
2. Confirm it redirects to the Hostinger HTTPS origin.
3. Confirm the **Set Your Password** screen appears.
4. Set a temporary test password.
5. Confirm the correct employee portal opens.
6. Sign out.
7. Sign in normally with the new password.
8. Confirm the recovery link cannot be reused.

Do not distribute recovery links to all employees until this test passes.
