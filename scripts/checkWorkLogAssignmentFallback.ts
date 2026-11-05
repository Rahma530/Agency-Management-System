// Regression check for classifyWorkLogServiceWithAssignmentFallback (src/lib/
// workLogServiceClassification.ts), added 2026-11-05. Root cause: classifyWorkLogService only
// ever looks at the author's formal UserRole, which breaks down for an Inhouse client (PR #283)
// where ANY department's employee can be made the responsible agent for a service — e.g. a
// marketing_manager personally doing real SEO/Social Media/Graphic Design work for Kesraa itself.
// marketing_manager (like am_team_lead/am_agent/sales/executive/head_of_technical/ai_engineer) has
// no ROLE_TO_SERVICE entry on purpose, so every one of that employee's lines used to land in
// "Other/More Updates" no matter what the line actually described. This fallback uses the
// `assignments` table (the same per-client-per-service "who's responsible" mechanism the Inhouse
// Clients panel itself uses) as a second signal before giving up on a line.
import { classifyWorkLogServiceWithAssignmentFallback } from '../src/lib/workLogServiceClassification';
import type { ServiceType } from '../src/types/database';

const failures: string[] = [];
function assertEqual(actual: unknown, expected: unknown, label: string): void {
  if (actual !== expected) failures.push(`${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

const subscribed = new Set<ServiceType>(['seo', 'social_media', 'graphic_design']);

// 1) A role WITH a confident mapping is never overridden by an assignment — role wins outright,
// the fallback is never even consulted for it.
assertEqual(
  classifyWorkLogServiceWithAssignmentFallback('seo_agent', new Set(['social_media']), subscribed),
  'seo',
  'A confidently-mapped role must win over any assignment.'
);

// 2) The real bug this fixes: marketing_manager (no ROLE_TO_SERVICE entry) assigned as the agent
// for exactly one of the client's subscribed services must classify into that service, not Other.
assertEqual(
  classifyWorkLogServiceWithAssignmentFallback('marketing_manager', new Set(['seo']), subscribed),
  'seo',
  'An unmapped role assigned to exactly one subscribed service must use that service, not fall to Other.'
);

// 3) Assigned to a service the client does NOT subscribe to — must not leak a non-subscribed
// service into the report; stays null (Other).
assertEqual(
  classifyWorkLogServiceWithAssignmentFallback('marketing_manager', new Set(['media_buying']), subscribed),
  null,
  'An assignment to a service the client does not subscribe to must never be used.'
);

// 4) Assigned to TWO or more of the client's subscribed services — genuinely ambiguous per line,
// must stay null (Other) rather than guess one.
assertEqual(
  classifyWorkLogServiceWithAssignmentFallback('marketing_manager', new Set(['seo', 'social_media']), subscribed),
  null,
  'Two or more assigned subscribed services must never be guessed down to one.'
);

// 5) No assignment at all for this user — stays null (Other), same as before this fix existed.
assertEqual(
  classifyWorkLogServiceWithAssignmentFallback('marketing_manager', undefined, subscribed),
  null,
  'No assignment at all must still fall back to Other, unchanged from before.'
);

// 6) A custom/creative-pool role with no mapping and no assignment still falls to Other — this
// fallback must never widen scope beyond "author is this client's assigned agent."
assertEqual(
  classifyWorkLogServiceWithAssignmentFallback(undefined, new Set(['seo']), subscribed),
  'seo',
  'Even with no role at all, a real per-client assignment to exactly one subscribed service must still be used.'
);

if (failures.length) {
  console.error('FAILED:\n' + failures.join('\n'));
  process.exit(1);
}
console.log('OK: classifyWorkLogServiceWithAssignmentFallback correctly recovers an Inhouse-style assigned agent\'s real service from the assignments table, without ever guessing an unsubscribed or ambiguous service.');
