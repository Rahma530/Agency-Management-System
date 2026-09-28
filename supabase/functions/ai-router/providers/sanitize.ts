// Shared helper: a provider occasionally echoes a bad/expired key back in its own error body for
// debugging purposes (e.g. "Invalid Authorization header: Bearer sk-abc123..."). Every adapter
// runs its own request's actual secret(s) through this before including any provider response
// body in an error message, so a leaked upstream error body never carries our key/token into logs
// or the ok:false response.
export function sanitizeProviderErrorBody(text: string, secrets: (string | undefined)[]): string {
  let sanitized = text;
  for (const secret of secrets) {
    // Guard against redacting trivially short values that could coincidentally appear in normal
    // error text (an empty/unset secret is falsy already; the length check is for very short keys).
    if (secret && secret.length >= 8) {
      sanitized = sanitized.split(secret).join('[redacted]');
    }
  }
  return sanitized;
}
