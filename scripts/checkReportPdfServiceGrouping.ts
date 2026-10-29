import { classifyWorkLogService } from '../src/lib/workLogServiceClassification';
import {
  OTHER_SERVICE_BUCKET_LABEL,
  parseReportContentIntoParagraphs,
  REPORT_SECTION_HEADINGS,
} from '../src/lib/pdfExport';

// 1) classifyWorkLogService: the roles with a confident, exclusive mapping go to their service;
// the shared graphic_designer/video_editor creative pool goes to the dedicated 'creative' bucket
// (see CREATIVE_BUCKET_LABEL — this predates the Creative tab/bucket feature and used to wrongly
// expect null here); everything else (am/sales/executive/an UNREGISTERED custom role, undefined)
// falls back to null (the "Other updates" bucket upstream), never a guessed service. A custom role
// that IS registered with a real department is covered separately in
// checkReportBucketCustomRoles.ts.
{
  const expectConfident: [string, string][] = [
    ['seo_team_lead', 'seo'], ['seo_agent', 'seo'], ['store_manager', 'seo'],
    ['seo_content_agent', 'seo'], ['seo_backlink_agent', 'seo'],
    ['media_buying_team_lead', 'media_buying'], ['media_buying_agent', 'media_buying'],
    ['social_media_team_lead', 'social_media'], ['social_media_agent', 'social_media'],
    ['ui_ux_designer', 'interface'],
    ['programming_agent', 'creation'],
  ];
  expectConfident.forEach(([role, service]) => {
    if (classifyWorkLogService(role) !== service) throw new Error(`${role} must classify as ${service}.`);
  });
  const expectCreative = ['graphic_designer', 'video_editor'];
  expectCreative.forEach((role) => {
    if (classifyWorkLogService(role) !== 'creative') throw new Error(`${role} must classify into the dedicated 'creative' bucket.`);
  });
  const expectNull = ['am_team_lead', 'am_agent', 'sales', 'executive', 'head_of_technical', 'ai_engineer', 'marketing_manager', 'some_custom_role', undefined];
  expectNull.forEach((role) => {
    if (classifyWorkLogService(role) !== null) throw new Error(`${role} must never be guessed into a service (no dedicated role, or an unregistered custom role) — got a service instead of null.`);
  });
}

// 2) parseReportContentIntoParagraphs: a report with no service sub-headings at all (an
// employee-scope report, or a client-scope one with only a single bucket) parses into one plain
// "Work logs (primary source)" paragraph, same as every other recognized section — never split,
// never a divider.
{
  const text = [
    `${REPORT_SECTION_HEADINGS.workLogs}\nSara: posted 3 stories`,
    `${REPORT_SECTION_HEADINGS.creatorContext}\nFocus on delivery this week.`,
  ].join('\n\n');
  const paragraphs = parseReportContentIntoParagraphs(text);
  if (paragraphs.length !== 2) throw new Error('Two recognized top-level sections must produce two paragraphs.');
  if (paragraphs[0].heading !== REPORT_SECTION_HEADINGS.workLogs || paragraphs[0].divider) {
    throw new Error('A work-log section with no sub-headings must stay one plain, non-divided paragraph.');
  }
  if (paragraphs[1].heading !== REPORT_SECTION_HEADINGS.creatorContext) throw new Error('The second recognized section must keep its own heading.');
}

// 3) A client-scope report with real per-service sub-headings inside Work logs splits into one
// paragraph per service, in the order they appear in the text, with divider=true on every one
// except the first (globally first in the whole document, not just first within the section).
{
  const text = [
    `${REPORT_SECTION_HEADINGS.workLogs}\nMedia Buying\nOmar: launched 2 campaigns\n\nSocial Media\nSara: posted 3 stories\n\n${OTHER_SERVICE_BUCKET_LABEL}\nNoor: reviewed brand assets`,
    `${REPORT_SECTION_HEADINGS.creatorContext}\nFocus on delivery this week.`,
  ].join('\n\n');
  const paragraphs = parseReportContentIntoParagraphs(text);
  if (paragraphs.length !== 4) throw new Error('3 service sub-sections + 1 other top-level section must produce 4 paragraphs.');
  const [mediaBuying, socialMedia, other, context] = paragraphs;
  if (mediaBuying.heading !== 'Media Buying' || mediaBuying.divider) throw new Error('The very first paragraph in the document must never carry a divider.');
  if (socialMedia.heading !== 'Social Media' || !socialMedia.divider) throw new Error('Every service sub-section after the first must carry a divider.');
  if (other.heading !== OTHER_SERVICE_BUCKET_LABEL || !other.divider) throw new Error('The Other-updates bucket must render as its own divided paragraph too.');
  if (context.heading !== REPORT_SECTION_HEADINGS.creatorContext || !context.body.includes('Focus on delivery')) {
    throw new Error('A later top-level section must still render correctly after a split work-log section.');
  }
}

// 4) Safety net: a top-level shape that doesn't match at all — free prose, a renamed top
// heading — degrades to the single legacy "Final Report" paragraph, never throws, never silently
// drops content.
{
  const degenerateCases = [
    'Just some free-form prose the user typed over everything, no headings at all.',
    `Some Renamed Heading\nOmar: did some work\n\n${REPORT_SECTION_HEADINGS.creatorContext}\nNotes.`,
    '',
  ];
  degenerateCases.forEach((text) => {
    const paragraphs = parseReportContentIntoParagraphs(text);
    if (paragraphs.length !== 1 || paragraphs[0].heading !== 'Final Report' || paragraphs[0].body !== text) {
      throw new Error(`A non-matching top-level shape must fall back to one untouched "Final Report" paragraph: ${JSON.stringify(text)}`);
    }
  });
}

// 5) Narrower safety net: when the TOP-level shape is fine but the work-logs section's own
// sub-headings don't fully match the known set (one renamed by hand) — the fallback is scoped to
// just that section, not the whole document: Work logs renders as one plain, unsplit paragraph
// (its original text fully intact), while a later recognized top-level section still gets its own
// heading, exactly as if no grouping had ever been attempted.
{
  const text = [
    `${REPORT_SECTION_HEADINGS.workLogs}\nA Renamed Service\nOmar: did some work\n\nSocial Media\nSara: posted a story`,
    `${REPORT_SECTION_HEADINGS.creatorContext}\nNotes.`,
  ].join('\n\n');
  const paragraphs = parseReportContentIntoParagraphs(text);
  if (paragraphs.length !== 2) throw new Error('A work-log section with a partially-renamed sub-heading must still produce its own paragraph plus the next recognized section, not collapse to one Final Report blob.');
  const [workLogs, context] = paragraphs;
  if (workLogs.heading !== REPORT_SECTION_HEADINGS.workLogs || workLogs.divider) throw new Error('A degraded (unsplit) work-log section must keep its own original heading and never carry a divider.');
  if (!workLogs.body.includes('A Renamed Service') || !workLogs.body.includes('Social Media')) throw new Error('A degraded work-log section must keep its full original text untouched — nothing dropped.');
  if (context.heading !== REPORT_SECTION_HEADINGS.creatorContext) throw new Error('A later recognized top-level section must still parse correctly even when an earlier section degraded.');
}

console.log('OK: work-log service classification never guesses a shared/ambiguous role into a service, and the PDF-by-service parser recovers the generated structure exactly or falls back safely to one untouched paragraph.');
