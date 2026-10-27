// "A new version is deployed" detection, with zero changes to deploy.yml or any build step.
//
// How it works: Vite's production build gives the JS bundle a content hash in its filename (e.g.
// /assets/index-CYqioC8T.js) and rewrites index.html's <script type="module" src="..."> tag to
// point at it. index.html itself is the one file this app deliberately serves with no-cache
// headers (see its own <meta http-equiv="Cache-Control"> comment and public/.htaccess) so the
// browser always re-fetches it fresh — which means re-fetching "/" right now and reading which
// bundle filename it currently points to tells us, cheaply, whether a newer build has been
// deployed since this tab loaded its own bundle. No server-side version endpoint, no service
// worker, no CI changes.
//
// False negatives are fine (worst case: the banner shows a little late, next poll catches it).
// False positives are not — a wrong "update available" nag that doesn't go away on reload would
// be worse than the problem this solves, so every failure mode below resolves to "no update
// detected" rather than guessing.

const BUNDLE_SRC_PATTERN = /<script[^>]*type="module"[^>]*\bsrc="([^"]*\/assets\/[^"]+)"[^>]*>/i;

// The currently-running bundle's own <script> src, read once from the live DOM index.html
// rendered into (the exact tag Vite's build emitted for this page load). Returns null in dev
// (src="/src/main.tsx", not a hashed /assets/ path) or if the markup is ever restructured —
// either way, hasNewVersionDeployed() below then always reports "no update", never a guess.
const getRunningBundleSrc = (): string | null => {
  const script = document.querySelector('script[type="module"][src*="/assets/"]');
  return script?.getAttribute('src') || null;
};

export async function hasNewVersionDeployed(): Promise<boolean> {
  const runningSrc = getRunningBundleSrc();
  if (!runningSrc) return false;

  try {
    const response = await fetch(`/?v=${Date.now()}`, { cache: 'no-store' });
    if (!response.ok) return false;
    const html = await response.text();
    const latestSrc = html.match(BUNDLE_SRC_PATTERN)?.[1];
    return !!latestSrc && latestSrc !== runningSrc;
  } catch {
    // Offline / request blocked / transient network error — never false-positive the banner.
    return false;
  }
}
