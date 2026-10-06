/**
 * Fails if any file other than src/lib/clientServices.ts reads `.services` or `.other_services`
 * directly off a client-shaped object (client.services / c.services / client.other_services /
 * c.other_services) in application code.
 *
 * Why: a client's real set of subscribed services is the union of `services` and
 * `other_services` — getClientServices(client) in src/lib/clientServices.ts is the one place that
 * union is computed, and getClientCustomServices(client) is the one place `other_services`'
 * genuine free-text entries are read out. A call site that reads either column directly would
 * silently miss the other, with no compile error to catch it. This check exists so that gap can
 * never be reintroduced by accident; it isn't full type-aware analysis, just a targeted text scan
 * for the exact identifier patterns this codebase uses for an existing ClientRecord (`client`,
 * `c`) — matches inside `//` line comments are stripped first so prose explaining this exact file
 * (like this one) doesn't trip it.
 *
 * Deliberately does NOT match `clientData.services`/`clientData.other_services`: that identifier
 * is this codebase's convention for a registration-form/CSV-row payload describing a client not
 * yet created (see handleRegisterClient/handleBulkAddClient in App.tsx) — never an existing
 * ClientRecord — so it's out of this check's scope; those payloads are themselves expected to
 * already be the output of splitClientServices(), not raw selections.
 *
 * Run via `npm run lint` (chained after tsc --noEmit) or directly: `npx tsx
 * scripts/checkClientServicesAccess.ts`.
 */
import { readFileSync, readdirSync } from 'fs';
import { dirname, join, relative, sep } from 'path';
import { fileURLToPath } from 'url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SRC_DIR = join(ROOT, 'src');
const ALLOWED_FILE = join('src', 'lib', 'clientServices.ts');
const PATTERN = /\b(?:client|c)\.(?:services|other_services)\b/;

function listSourceFiles(dir: string): string[] {
  const entries = readdirSync(dir, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...listSourceFiles(full));
    } else if (/\.(ts|tsx)$/.test(entry.name)) {
      files.push(full);
    }
  }
  return files;
}

function stripLineComment(line: string): string {
  // Best-effort: drop everything from the first `//` onward so a comment explaining
  // "client.services" in prose (e.g. this file's own header) doesn't trip the check. Does not
  // handle `//` inside a string literal, but that combination doesn't occur with this identifier
  // anywhere in this codebase today.
  const idx = line.indexOf('//');
  return idx === -1 ? line : line.slice(0, idx);
}

interface Violation {
  file: string;
  line: number;
  text: string;
}

function main(): void {
  const violations: Violation[] = [];

  for (const absPath of listSourceFiles(SRC_DIR)) {
    const relPath = relative(ROOT, absPath).split(sep).join('/');
    if (relPath === ALLOWED_FILE.split(sep).join('/')) continue;

    const lines = readFileSync(absPath, 'utf8').split('\n');
    lines.forEach((raw, index) => {
      const code = stripLineComment(raw);
      if (PATTERN.test(code)) {
        violations.push({ file: relPath, line: index + 1, text: raw.trim() });
      }
    });
  }

  if (violations.length > 0) {
    console.error('Found direct client.services/other_services access outside src/lib/clientServices.ts:\n');
    for (const v of violations) {
      console.error(`  ${v.file}:${v.line}: ${v.text}`);
    }
    console.error(
      '\nUse getClientServices(client) (or getClientCustomServices(client) for free-text entries) ' +
        'from src/lib/clientServices.ts instead.'
    );
    process.exit(1);
  }

  console.log('OK: no direct client.services/other_services access outside src/lib/clientServices.ts.');
}

main();
