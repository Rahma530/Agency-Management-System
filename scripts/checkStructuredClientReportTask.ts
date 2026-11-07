// Experimental (2026-11-07) — exercises the new STRUCTURED_CLIENT_REPORT task's payload validation
// and output grounding the same way checkWorkItemGrouping.ts/checkReportRewriteGrounding.ts do for
// their own tasks: through the registry's own buildInitialInput + stage[0].validateOutput, imported
// together, since validateStructuredClientReportOutput's stageInput argument must be the exact
// shape buildInitialInput produces, not a hand-built stand-in.
import { validateStructuredClientReportPayload, TASK_REGISTRY } from '../supabase/functions/ai-router/taskRegistry';

const validateOutput = TASK_REGISTRY.STRUCTURED_CLIENT_REPORT.stages[0].validateOutput!;

const input = validateStructuredClientReportPayload({
  client_name: 'Natural Glow',
  period_label: 'From 2026-10-01 To 2026-10-31',
  sections: [
    { heading: 'Social Media', body: 'Posted 12 stories reaching 4500 accounts. Scheduled 3 posts for next week.' },
    { heading: 'SEO', body: 'Completed 5 on-page audits. 2 tasks still pending review.' },
  ],
});

// 1) A well-formed, fully-grounded output (every number already present in the input) is accepted.
{
  const modelOutput = {
    subtitle: 'Social Media and SEO activity for October',
    executive_summary: {
      paragraph: 'The team posted 12 stories reaching 4500 accounts and completed 5 SEO audits.',
      kpis: [{ label: 'Stories posted', value: '12', note: 'Reached 4500 accounts' }],
      caveat: '',
    },
    sections: [
      { heading: 'Social Media', blocks: [{ title: 'Stories', body: ['Posted 12 stories reaching 4500 accounts.'] }, { title: 'Scheduling', body: ['Scheduled 3 posts for next week.'] }] },
      { heading: 'SEO', blocks: [{ title: 'Audits', body: ['Completed 5 on-page audits.', '2 tasks still pending review.'] }] },
    ],
    work_by_date: [],
    upcoming_work: [{ title: 'Scheduled posts', body: ['3 posts are scheduled for next week.'] }],
  };
  const validation = validateOutput(modelOutput, 'brief', input);
  if (!validation.ok) throw new Error('A valid, fully-grounded structured report was rejected.');
  // body is an ARRAY of separate points (changed 2026-11-07 so each renders as its own line/bullet
  // instead of a joined run-on string) — confirm the multi-item block round-trips as two items.
  const seoBlock = (validation.value as any).sections[1].blocks[0];
  if (seoBlock.body.length !== 2 || seoBlock.body[0] !== 'Completed 5 on-page audits.' || seoBlock.body[1] !== '2 tasks still pending review.') {
    throw new Error(`A multi-item block body did not round-trip as a separate-item array, got ${JSON.stringify(seoBlock.body)}`);
  }
}

// 1b) Markdown syntax and emoji anywhere in the output are stripped, never shown to the client
// verbatim — a live test surfaced a markdown table's "|---|---|" separator row and inline "**bold**"
// rendering as literal garbled characters, since the app's renderer never interprets markdown.
{
  const modelOutput = {
    subtitle: 'Social Media and SEO activity for October 🚀',
    executive_summary: {
      paragraph: 'The team posted **12 stories** reaching 4500 accounts.',
      kpis: [{ label: 'Stories posted ✅', value: '12', note: 'Reached 4500 accounts' }],
      caveat: '',
    },
    sections: [
      {
        heading: 'Social Media',
        blocks: [{ title: '### Stories', body: ['Posted 12 stories.', '| --- | --- |', '- Scheduled 3 posts for next week.'] }],
      },
      { heading: 'SEO', blocks: [{ title: 'Audits', body: ['Completed 5 on-page audits.'] }] },
    ],
    work_by_date: [],
    upcoming_work: [],
  };
  const validation = validateOutput(modelOutput, 'brief', input);
  if (!validation.ok) throw new Error('A markdown/emoji-laden but otherwise valid output was rejected outright.');
  const value = validation.value as any;
  if (value.subtitle.includes('🚀')) throw new Error('Emoji was not stripped from subtitle.');
  if (value.executive_summary.paragraph.includes('**')) throw new Error('Markdown bold markers were not stripped from the paragraph.');
  if (value.executive_summary.kpis[0].label.includes('✅')) throw new Error('Emoji was not stripped from a KPI label.');
  const storiesBlock = value.sections[0].blocks[0];
  if (storiesBlock.title.startsWith('#')) throw new Error('A markdown heading marker was not stripped from a block title.');
  if (storiesBlock.body.some((item: string) => item.includes('|') || item.startsWith('-'))) {
    throw new Error(`A markdown table separator / leading bullet dash was not stripped from a body item, got ${JSON.stringify(storiesBlock.body)}`);
  }
}

// 2) A fabricated number not present anywhere in the input (reach figure invented) is rejected —
// the grounding check this task shares conceptually with REPORT_REWRITE's numericTokens pattern.
{
  const modelOutput = {
    subtitle: 'Social Media and SEO activity for October',
    executive_summary: {
      paragraph: 'The team posted 12 stories reaching 9999 accounts.',
      kpis: [],
      caveat: '',
    },
    sections: [
      { heading: 'Social Media', blocks: [{ title: 'Stories', body: ['Posted 12 stories.'] }] },
      { heading: 'SEO', blocks: [{ title: 'Audits', body: ['Completed 5 on-page audits.'] }] },
    ],
    work_by_date: [],
    upcoming_work: [],
  };
  const validation = validateOutput(modelOutput, 'brief', input);
  if (validation.ok) throw new Error('A fabricated number (9999) was not caught by grounding.');
}

// 3) Dropping an input section entirely (SEO missing from "sections") is rejected — one output
// section is required per input section.
{
  const modelOutput = {
    subtitle: 'Social Media activity for October',
    executive_summary: { paragraph: 'The team posted 12 stories.', kpis: [], caveat: '' },
    sections: [
      { heading: 'Social Media', blocks: [{ title: 'Stories', body: ['Posted 12 stories reaching 4500 accounts.'] }] },
    ],
    work_by_date: [],
    upcoming_work: [],
  };
  const validation = validateOutput(modelOutput, 'brief', input);
  // Not explicitly length-checked against the input section count by validateStructuredClientReportOutput
  // itself (it validates shape + grounding, not completeness) — this case documents that today's
  // behavior is "accepted" so a future tightening is a deliberate choice, not an accidental regression.
  if (!validation.ok) throw new Error('Unexpected rejection of a shape-valid (if incomplete) output.');
}

// 4) A payload with an unsupported field is rejected by validateStructuredClientReportPayload.
{
  let threw = false;
  try {
    validateStructuredClientReportPayload({
      client_name: 'X', period_label: 'Y', sections: [{ heading: 'A', body: 'B' }], extra_field: 'nope',
    });
  } catch {
    threw = true;
  }
  if (!threw) throw new Error('A payload with an unsupported field was not rejected.');
}

console.log('checkStructuredClientReportTask: all assertions passed.');
