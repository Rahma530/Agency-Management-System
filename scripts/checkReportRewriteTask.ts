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

let unknownFieldRejected = false;
try {
  validateReportRewritePayload({ ...input, unexpected: 'secret' });
} catch {
  unknownFieldRejected = true;
}
if (!unknownFieldRejected) throw new Error('Unknown rewrite payload field was accepted.');

console.log('OK: REPORT_REWRITE validates its payload and rejects unsupported numbers.');
