// Regression check for the report service bucket filter (src/lib/reportServiceFilter.ts). The
// server rules live in supabase/migrations/20261127000000_report_service_bucket_filter.sql; this
// checks the client side that builds the value sent to the server and matched against saved
// reports:
//   - "All Services" never includes creative by default,
//   - the stored string is canonical (fixed order, no duplicates), so the same selection always
//     matches the same saved report,
//   - an empty selection never produces a value (null would mean "every bucket" on the server),
//   - the Creative view sends the creative bucket alone.
//
// Run via `npm run lint` or directly: `npx tsx scripts/checkReportServiceFilter.ts`.
import {
  ALL_SERVICES_TOKENS,
  CREATIVE_TOKEN,
  DEFAULT_ALL_SERVICES_SELECTION,
  allServicesFilterValue,
} from '../src/lib/reportServiceFilter';

const failures: string[] = [];

function assertEqual<T>(actual: T, expected: T, label: string): void {
  if (actual !== expected) failures.push(`${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

// 1. Default selection excludes creative and includes the three priority services.
assertEqual(DEFAULT_ALL_SERVICES_SELECTION.includes(CREATIVE_TOKEN as never), false, 'default All Services excludes creative');
for (const core of ['media_buying', 'social_media', 'seo'] as const) {
  assertEqual(DEFAULT_ALL_SERVICES_SELECTION.includes(core), true, `default includes ${core}`);
}
assertEqual(allServicesFilterValue(DEFAULT_ALL_SERVICES_SELECTION), ALL_SERVICES_TOKENS.join(','), 'default stored value is every non-creative bucket, in order');

// 2. Canonical ordering regardless of the order the user clicked things in.
assertEqual(allServicesFilterValue(['seo', 'media_buying']), 'media_buying,seo', 'canonical order: media_buying before seo');
assertEqual(allServicesFilterValue(['other', 'seo', 'seo']), 'seo,other', 'canonical order and no duplicates');

// 3. Empty selection never yields a value.
assertEqual(allServicesFilterValue([]), null, 'empty selection yields null (UI must prevent it)');

// 4. Creative view sends the creative bucket alone (the constant, not a selection).
assertEqual(CREATIVE_TOKEN, 'creative', 'creative view token');

if (failures.length > 0) {
  console.error('checkReportServiceFilter FAILED:\n' + failures.map((f) => `  - ${f}`).join('\n'));
  process.exit(1);
}
console.log('checkReportServiceFilter: all scenarios passed.');
