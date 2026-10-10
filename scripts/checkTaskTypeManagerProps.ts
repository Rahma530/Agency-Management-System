/**
 * Fails if any `<CrossTeamTaskBoard ...>` JSX render site is missing one of the three Task Types
 * admin props: taskTypes, onCreateTaskType, onUpdateTaskType.
 *
 * Why: this project has no @types/react or @types/react-dom installed (confirmed by direct
 * experiment — a JSX element with a missing or extra prop produces zero tsc errors here, because
 * every JSX expression types as `any`). Declaring these props required in
 * CrossTeamTaskBoardProps therefore gives no actual compile-time protection against a render site
 * silently dropping one of them — only a text-level scan like this one can catch that. Checks
 * `<CrossTeamTaskBoard` specifically rather than every component, since that's the one render site
 * this task's props were added to; a future second render site is caught automatically, since this
 * scans the whole src tree rather than a fixed file list.
 *
 * Run via `npm run lint` (chained after tsc --noEmit) or directly: `npx tsx
 * scripts/checkTaskTypeManagerProps.ts`.
 */
import { readFileSync, readdirSync } from 'fs';
import { dirname, join, relative, sep } from 'path';
import { fileURLToPath } from 'url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SRC_DIR = join(ROOT, 'src');
const TAG = '<CrossTeamTaskBoard';
const REQUIRED_PROPS = ['taskTypes', 'onCreateTaskType', 'onUpdateTaskType'];

function listSourceFiles(dir: string): string[] {
  const entries = readdirSync(dir, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...listSourceFiles(full));
    } else if (/\.tsx$/.test(entry.name)) {
      files.push(full);
    }
  }
  return files;
}

// Finds the index of the '>' (or the '>' of a trailing '/>') that closes the opening tag starting
// at `startIdx`, tracking brace depth and string literals so a stray '>' inside an attribute value
// (e.g. an arrow function's `=>`, or a comparison) never terminates the scan early.
function findOpeningTagEnd(text: string, startIdx: number): number {
  let i = startIdx;
  let braceDepth = 0;
  let inString: string | null = null;
  while (i < text.length) {
    const ch = text[i];
    if (inString) {
      if (ch === '\\') {
        i += 2;
        continue;
      }
      if (ch === inString) inString = null;
      i++;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') {
      inString = ch;
      i++;
      continue;
    }
    if (ch === '{') {
      braceDepth++;
      i++;
      continue;
    }
    if (ch === '}') {
      braceDepth--;
      i++;
      continue;
    }
    if (braceDepth === 0 && ch === '>') {
      return i;
    }
    i++;
  }
  return -1;
}

interface Violation {
  file: string;
  missing: string[];
}

function main(): void {
  const violations: Violation[] = [];

  for (const absPath of listSourceFiles(SRC_DIR)) {
    const relPath = relative(ROOT, absPath).split(sep).join('/');
    const text = readFileSync(absPath, 'utf8');

    let searchFrom = 0;
    while (true) {
      const tagStart = text.indexOf(TAG, searchFrom);
      if (tagStart === -1) break;
      // Guard against matching a longer component name that happens to start with this tag
      // (e.g. `<CrossTeamTaskBoardSomething`) — the character right after the tag name must not
      // be a further identifier character.
      const afterTag = text[tagStart + TAG.length];
      if (afterTag && /[A-Za-z0-9_]/.test(afterTag)) {
        searchFrom = tagStart + TAG.length;
        continue;
      }

      const tagEnd = findOpeningTagEnd(text, tagStart + TAG.length);
      if (tagEnd === -1) break;
      const tagText = text.slice(tagStart, tagEnd + 1);

      const missing = REQUIRED_PROPS.filter((prop) => !new RegExp(`[\\s{]${prop}=`).test(tagText));
      if (missing.length > 0) {
        violations.push({ file: relPath, missing });
      }

      searchFrom = tagEnd + 1;
    }
  }

  if (violations.length > 0) {
    console.error('Found <CrossTeamTaskBoard> render site(s) missing required Task Types admin props:\n');
    for (const v of violations) {
      console.error(`  ${v.file}: missing ${v.missing.join(', ')}`);
    }
    console.error(
      '\nEvery <CrossTeamTaskBoard> render site must pass taskTypes, onCreateTaskType, and ' +
        'onUpdateTaskType — tsc cannot catch a missing prop here (no @types/react is installed).'
    );
    process.exit(1);
  }

  console.log('OK: every <CrossTeamTaskBoard> render site passes taskTypes/onCreateTaskType/onUpdateTaskType.');
}

main();
