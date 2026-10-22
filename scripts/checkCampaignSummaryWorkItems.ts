import { buildAnalyzeInput, validateAnalyzeOutput, validateCampaignSummaryPayload } from '../supabase/functions/ai-router/taskRegistry';

const basePayload = {
  period_current: '2026-10',
  period_previous: '2026-09',
  metrics: [{ service: 'media_buying', metric: 'roas', current_value: 3.2, previous_value: 2.8, unit: 'x' }],
};

// 1) No work_items at all — behaves exactly as before this field existed.
{
  const result = validateCampaignSummaryPayload(basePayload);
  if ('work_items' in result) throw new Error('A payload with no work_items must not gain one.');
  const input = buildAnalyzeInput(result) as Record<string, unknown>;
  if ('work_items' in input) throw new Error('buildAnalyzeInput must not add work_items when none was given.');
  const output = validateAnalyzeOutput({ findings: ['x'], recommendations: [] }, 'brief', input);
  if (!output.ok || 'work_items' in (output.value as Record<string, unknown>)) {
    throw new Error('validateAnalyzeOutput must not add work_items to its output when none was in the input.');
  }
}

const workItems = [
  { id: 'a', employee: 'Sara', text: 'Finished the onboarding deck for the client.' },
  { id: 'b', employee: 'Omar', text: 'Published 3 social posts and replied to comments.' },
  { id: 'c', employee: 'Sara', text: 'Fixed a tracking pixel issue on the landing page.' },
];

// 2) A normal batch: payload/input round-trip the ids+text, output is built from them.
{
  const result = validateCampaignSummaryPayload({ ...basePayload, work_items: workItems });
  if (result.work_items?.length !== 3) throw new Error('A valid work_items batch was not accepted.');
  const input = buildAnalyzeInput(result) as { work_items: typeof workItems };
  if (input.work_items.length !== 3 || input.work_items[0].text !== workItems[0].text) {
    throw new Error('buildAnalyzeInput must pass work_items through verbatim.');
  }
}

// 3) Missing item in the model's output (dropped, not just reordered) — every input id must
// still appear in the final value, and the missing one must fall back to its ORIGINAL text, not
// be deleted or left blank.
{
  const result = validateCampaignSummaryPayload({ ...basePayload, work_items: workItems });
  const input = buildAnalyzeInput(result);
  const modelOutput = {
    summary: 'All good.',
    by_service: [{ service: 'media_buying', text: 'ROAS improved.' }],
    recommendations: [],
    // "b" is missing entirely — simulates the model dropping an item.
    work_items: [
      { id: 'a', text: 'أنهت سارة تصميم ملف التعريف للعميل.' },
      { id: 'c', text: 'عالجت سارة مشكلة في بكسل التتبع على صفحة الهبوط.' },
    ],
  };
  const validation = validateAnalyzeOutput(modelOutput, 'detailed', input);
  if (!validation.ok) throw new Error('A valid detailed output with a partially-missing work_items batch was rejected.');
  const value = validation.value as { work_items: { id: string; text: string }[] };
  if (value.work_items.length !== 3) throw new Error('A missing work_items id must still appear in the final output (never dropped).');
  const byId = new Map(value.work_items.map((w) => [w.id, w.text]));
  if (byId.get('a') !== 'أنهت سارة تصميم ملف التعريف للعميل.') throw new Error('A present id\'s rephrased text was not kept.');
  if (byId.get('b') !== workItems[1].text) throw new Error('A missing id must fall back to its exact original source text.');
  if (byId.get('c') !== 'عالجت سارة مشكلة في بكسل التتبع على صفحة الهبوط.') throw new Error('A present id\'s rephrased text was not kept.');
}

// 4) Output order differs from input order — the final value must still be in the ORIGINAL input
// order (never left to whatever order the model answered in), so a caller can render items
// predictably without re-sorting.
{
  const result = validateCampaignSummaryPayload({ ...basePayload, work_items: workItems });
  const input = buildAnalyzeInput(result);
  const modelOutput = {
    findings: ['x'],
    recommendations: [],
    work_items: [
      { id: 'c', text: 'rephrased c' },
      { id: 'a', text: 'rephrased a' },
      { id: 'b', text: 'rephrased b' },
    ],
  };
  const validation = validateAnalyzeOutput(modelOutput, 'brief', input);
  if (!validation.ok) throw new Error('A reordered-but-complete work_items batch was rejected.');
  const value = validation.value as { work_items: { id: string; text: string }[] };
  if (value.work_items.map((w) => w.id).join(',') !== 'a,b,c') {
    throw new Error('validateAnalyzeOutput must return work_items in the original input order, not the model\'s order.');
  }
}

// 5) A long text item is rephrased (and can legitimately get shorter or longer in a real model
// reply) but must never be silently dropped just because it's long — only an outright-missing id
// triggers the original-text fallback, not length.
{
  const longText = 'بند طويل جدا. '.repeat(50);
  const result = validateCampaignSummaryPayload({ ...basePayload, work_items: [{ id: 'z', text: longText }] });
  const input = buildAnalyzeInput(result);
  const validation = validateAnalyzeOutput(
    { findings: [], recommendations: [], work_items: [{ id: 'z', text: 'إعادة صياغة أقصر لنفس البند.' }] },
    'brief',
    input
  );
  if (!validation.ok) throw new Error('A rephrased-and-shortened long item was wrongly rejected.');
  const value = validation.value as { work_items: { id: string; text: string }[] };
  if (value.work_items[0].text !== 'إعادة صياغة أقصر لنفس البند.') {
    throw new Error('A long item\'s legitimately-shortened rephrasing must be kept, not replaced by the original.');
  }
}

// 6) Per-item number fidelity: a rephrase must never silently drop, alter, or invent a number
// that was (or wasn't) already in that item's own original text — reported bug: a merged "Group
// similar entries" line like "تم نشر 5 ستوري" (count verified server-side — see
// validateWorkItemGroupOutput above) coming back from AI Summary's rephrase as a generic sentence
// with the "5" silently gone. Checked per item, independent of every other item in the batch.
{
  const items = [
    { id: 'dropped', text: 'تم نشر 5 ستوري.' },
    { id: 'invented', text: 'أنهى العمل على الحملة.' },
    { id: 'reworded-kept', text: 'تم نشر 5 ستوري.' },
    { id: 'no-numbers', text: 'راجع المحتوى مع العميل.' },
  ];
  const result = validateCampaignSummaryPayload({ ...basePayload, work_items: items });
  const input = buildAnalyzeInput(result);
  const validation = validateAnalyzeOutput(
    {
      findings: [], recommendations: [],
      work_items: [
        { id: 'dropped', text: 'تم نشر ستوري.' }, // the "5" vanished — must fall back to original
        { id: 'invented', text: 'أنهى العمل على 3 حملات.' }, // "3" invented, wasn't in the original — must fall back
        { id: 'reworded-kept', text: 'نشرت 5 ستوريز على مدار الفترة.' }, // same number, different wording around it — must be kept
        { id: 'no-numbers', text: 'تمت مراجعة المحتوى مع العميل.' }, // no numbers either side — must be kept
      ],
    },
    'brief',
    input
  );
  if (!validation.ok) throw new Error('A work_items batch exercising the number-fidelity check was wrongly rejected outright.');
  const byId = new Map((validation.value as { work_items: { id: string; text: string }[] }).work_items.map((w) => [w.id, w.text]));
  if (byId.get('dropped') !== 'تم نشر 5 ستوري.') throw new Error('A rephrase that dropped the original count must fall back to the original text.');
  if (byId.get('invented') !== 'أنهى العمل على الحملة.') throw new Error('A rephrase that invented a number absent from the original must fall back to the original text.');
  if (byId.get('reworded-kept') !== 'نشرت 5 ستوريز على مدار الفترة.') throw new Error('A rephrase that kept the exact same number, just reworded around it, must be kept as rephrased.');
  if (byId.get('no-numbers') !== 'تمت مراجعة المحتوى مع العميل.') throw new Error('A rephrase with no numbers on either side must be kept as rephrased.');
}

// 7) Banned trailing-count phrasing ("5 مرات"/"times") surviving the number-fidelity check alone:
// a merged "Group similar entries" line like "تم نشر 5 ستوري" rephrased by THIS stage into
// "تم نشر ستوري 5 مرات" keeps the exact same numeric-token set ({5} on both sides), so test #6's
// check alone would accept it — reported recurrence of the already-banned "مرات" wording coming
// back through AI Summary's own rephrase pass, even after WORK_ITEM_GROUP's own output (which
// never contains it) was merged correctly. Must still fall back to the original text.
{
  const items = [
    { id: 'banned-reintroduced', text: 'تم نشر 5 ستوري.' },
    { id: 'banned-already-present', text: 'تم نشر ستوري 5 مرات.' }, // already banned going in — rephrase just keeps it; no regression to guard, still must not crash
    { id: 'clean-rephrase-kept', text: 'تم نشر 5 ستوري.' },
  ];
  const result = validateCampaignSummaryPayload({ ...basePayload, work_items: items });
  const input = buildAnalyzeInput(result);
  const validation = validateAnalyzeOutput(
    {
      findings: [], recommendations: [],
      work_items: [
        { id: 'banned-reintroduced', text: 'تم نشر ستوري 5 مرات.' }, // same number, but reintroduces the banned phrasing — must fall back
        { id: 'banned-already-present', text: 'نشر ستوري 5 مرات في الفترة.' }, // banned phrasing was already in the original too — not a NEW regression, so this one may be kept
        { id: 'clean-rephrase-kept', text: 'نشرت 5 ستوريز بنجاح.' }, // same number, no banned phrasing — must be kept
      ],
    },
    'brief',
    input
  );
  if (!validation.ok) throw new Error('A work_items batch exercising the banned-phrasing check was wrongly rejected outright.');
  const byId = new Map((validation.value as { work_items: { id: string; text: string }[] }).work_items.map((w) => [w.id, w.text]));
  if (byId.get('banned-reintroduced') !== 'تم نشر 5 ستوري.') {
    throw new Error('A rephrase that reintroduces the banned "مرات"/"times" trailing-count phrasing must fall back to the original text, even when its number is unchanged.');
  }
  if (byId.get('clean-rephrase-kept') !== 'نشرت 5 ستوريز بنجاح.') throw new Error('A clean rephrase with the same number and no banned phrasing must be kept.');
}

// Payload-level validation regressions: cap, shape, and uniqueness.
{
  let rejected = false;
  try { validateCampaignSummaryPayload({ ...basePayload, work_items: [] }); } catch { rejected = true; }
  if (!rejected) throw new Error('An empty work_items array must be rejected (omit the field instead).');
}
{
  let rejected = false;
  try {
    validateCampaignSummaryPayload({
      ...basePayload,
      work_items: Array.from({ length: 31 }, (_, i) => ({ id: String(i), text: 'x' })),
    });
  } catch { rejected = true; }
  if (!rejected) throw new Error('An oversized work_items batch was accepted — the caller must batch into smaller calls.');
}
{
  let rejected = false;
  try { validateCampaignSummaryPayload({ ...basePayload, work_items: [{ id: 'a', text: 'x' }, { id: 'a', text: 'y' }] }); } catch { rejected = true; }
  if (!rejected) throw new Error('Duplicate work_items ids within one batch were accepted.');
}
{
  let rejected = false;
  try { validateCampaignSummaryPayload({ ...basePayload, work_items: [{ id: 'a', text: 'x', unexpected: 'y' }] }); } catch { rejected = true; }
  if (!rejected) throw new Error('An unknown field inside a work_items entry was accepted.');
}

console.log('OK: CAMPAIGN_SUMMARY work_items are capped per batch, passed through verbatim, reconciled id-complete and in original order (missing ids falling back to their exact original text), a rephrase that drops/invents a number falls back to the original, and a rephrase that reintroduces the banned "مرات"/"times" trailing-count phrasing falls back too even when its number is unchanged.');
