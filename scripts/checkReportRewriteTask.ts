import {
  TASK_REGISTRY,
  validateReportRewriteOutput,
  validateReportRewritePayload,
} from '../supabase/functions/ai-router/taskRegistry';

const input = validateReportRewritePayload({
  report_id: 'report-1',
  current_text: 'حقق الفريق 10 نتائج خلال الفترة.',
  creator_note: 'حافظ على الرقم 10.',
  facts: ['النتيجة الموثقة: 10'],
  base_version_id: 'v1',
  source_hash: 'hash1',
  audience: 'client',
});

if (!TASK_REGISTRY.REPORT_REWRITE) throw new Error('REPORT_REWRITE is missing from the registry.');
const providerInput = TASK_REGISTRY.REPORT_REWRITE.buildInitialInput(input) as Record<string, unknown>;
if ('report_id' in providerInput || 'base_version_id' in providerInput || 'source_hash' in providerInput) {
  throw new Error('Internal version identifiers would be sent to the AI provider.');
}
if (!validateReportRewriteOutput({ suggested_text: 'حقق الفريق 10 نتائج موثقة.' }, 'brief', input).ok) {
  throw new Error('Grounded rewrite was rejected.');
}
if (validateReportRewriteOutput({ suggested_text: 'حقق الفريق 999 نتيجة.' }, 'brief', input).ok) {
  throw new Error('Invented Western number was accepted.');
}
if (validateReportRewriteOutput({ suggested_text: 'حقق الفريق ٩٩٩ نتيجة.' }, 'brief', input).ok) {
  throw new Error('Invented Arabic-Indic number was accepted.');
}

// Regression for the confirmed "Suggest rewrite" failure: a fact string carrying an ISO date
// (source_date, always YYYY-MM-DD) must not have its hyphens misread as negative-number tokens,
// and the Arabic quality rules' own instruction to drop a percentage's minus sign when the
// direction is already stated in words (ارتفع/انخفض/...) must not be rejected as an "invented"
// number — both were being rejected before numericTokens() stopped capturing a leading `-`.
const groundedDateAndSignInput = validateReportRewritePayload({
  report_id: 'report-2',
  current_text: 'انخفضت تكلفة الاكتساب بنسبة -26.2% بتاريخ 2026-02-15.',
  creator_note: '',
  facts: ['2026-02-15: task evidence — Launch reel; inferred kind: video; status: completed; linked work-log dates: 2026-02-15'],
  base_version_id: 'v2',
  source_hash: 'hash2',
  audience: 'internal',
});
if (!validateReportRewriteOutput(
  { suggested_text: 'انخفضت تكلفة الاكتساب بنسبة 26.2% بتاريخ 2026-02-15.' },
  'brief',
  groundedDateAndSignInput
).ok) {
  throw new Error('A grounded rewrite that drops the minus sign per the Arabic direction-in-words rule, or that repeats an ISO date, was rejected.');
}
if (validateReportRewriteOutput(
  { suggested_text: 'انخفضت تكلفة الاكتساب بنسبة 99.9% بتاريخ 2026-02-15.' },
  'brief',
  groundedDateAndSignInput
).ok) {
  throw new Error('An invented percentage (99.9, not in the input) was accepted.');
}

let unknownFieldRejected = false;
try {
  validateReportRewritePayload({ ...input, unexpected: 'secret' });
} catch {
  unknownFieldRejected = true;
}
if (!unknownFieldRejected) throw new Error('Unknown rewrite payload field was accepted.');

console.log('OK: REPORT_REWRITE validates its payload, rejects unsupported numbers, and tolerates ISO dates/sign-dropped percentages in Arabic text.');
