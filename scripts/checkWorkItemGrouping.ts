import { validateWorkItemGroupPayload } from '../supabase/functions/ai-router/taskRegistry';

// validateWorkItemGroupOutput isn't exported (same convention as validateAnalyzeOutput's private
// validateBriefAnalyzeOutput/validateDetailedAnalyzeOutput — only the dispatcher is public), so
// this check exercises it the same way the real runner does: through the registry's own
// buildInitialInput + the task definition's stage[0].validateOutput, imported together.
import { TASK_REGISTRY } from '../supabase/functions/ai-router/taskRegistry';

const validateOutput = TASK_REGISTRY.WORK_ITEM_GROUP.stages[0].validateOutput!;

const items = [
  { id: 'a', employee: 'Sara', text: 'نشرت ستوري' },
  { id: 'b', employee: 'Sara', text: 'تم نشر story' },
  { id: 'c', employee: 'Sara', text: 'نشرت ستوري جديدة' },
  { id: 'd', employee: 'Omar', text: 'نشرت ستوري' },
  { id: 'e', employee: 'Sara', text: 'راجعت تقرير الأداء الأسبوعي' },
];
const input = validateWorkItemGroupPayload({ items });

// 1) A clean, correctly-counted 3-item group for Sara is accepted and merged; Omar's lookalike
// line and Sara's unrelated line are left as their own untouched singletons.
{
  const modelOutput = [{ ids: ['a', 'b', 'c'], text: 'نشرت 3 ستوريز' }];
  const validation = validateOutput(modelOutput, 'brief', input);
  if (!validation.ok) throw new Error('A valid, correctly-counted group was rejected.');
  const groups = (validation.value as { groups: { ids: string[]; text: string }[] }).groups;
  const merged = groups.find((g) => g.ids.length > 1);
  if (!merged || merged.ids.slice().sort().join(',') !== 'a,b,c' || merged.text !== 'نشرت 3 ستوريز') {
    throw new Error('The 3-item merge was not produced with its exact ids and AI-authored text.');
  }
  const singleton = (id: string) => groups.find((g) => g.ids.length === 1 && g.ids[0] === id);
  if (!singleton('d') || singleton('d')!.text !== items[3].text) throw new Error('Omar\'s lookalike line must stay its own untouched singleton, never merged with Sara\'s.');
  if (!singleton('e') || singleton('e')!.text !== items[4].text) throw new Error('An unrelated same-employee line must stay its own untouched singleton.');
  if (groups.reduce((sum, g) => sum + g.ids.length, 0) !== items.length) throw new Error('Every input id must appear in exactly one group.');
}

// 2) The model's stated count does not match the real number of ids it grouped — the whole group
// is discarded (never trusted), and every one of its members falls back to its own original text.
{
  const modelOutput = [{ ids: ['a', 'b', 'c'], text: 'نشرت 5 ستوريز' }]; // 3 ids, claims 5
  const validation = validateOutput(modelOutput, 'brief', input);
  if (!validation.ok) throw new Error('validateOutput must never reject the whole stage — it degrades to singletons instead.');
  const groups = (validation.value as { groups: { ids: string[]; text: string }[] }).groups;
  if (groups.some((g) => g.ids.length > 1)) throw new Error('A group whose stated count does not match its real size must be discarded entirely, not merged.');
  const a = groups.find((g) => g.ids[0] === 'a');
  if (!a || a.text !== items[0].text) throw new Error('A discarded group\'s members must fall back to their own original text, unmerged.');
}

// 3) The model mixes two different employees into one group — discarded, same fallback.
{
  const modelOutput = [{ ids: ['a', 'd'], text: 'نشرا ستوريين' }];
  const validation = validateOutput(modelOutput, 'brief', input);
  if (!validation.ok) throw new Error('validateOutput must never reject the whole stage.');
  const groups = (validation.value as { groups: { ids: string[]; text: string }[] }).groups;
  if (groups.some((g) => g.ids.length > 1)) throw new Error('A cross-employee group must never be accepted, regardless of a plausible-looking count.');
}

// 4) The model's phrase mentions an extra number beyond the one required count — rejected, same
// fallback, so a stray number (a date, an unrelated figure) can never ride along unverified.
{
  const modelOutput = [{ ids: ['a', 'b'], text: 'نشرت 2 ستوريز يوم 5' }]; // two numbers: 2 and 5
  const validation = validateOutput(modelOutput, 'brief', input);
  if (!validation.ok) throw new Error('validateOutput must never reject the whole stage.');
  const groups = (validation.value as { groups: { ids: string[]; text: string }[] }).groups;
  if (groups.some((g) => g.ids.length > 1)) throw new Error('A phrase containing any number besides the verified count must be rejected.');
}

// 5) An id the model invents (not in the input) invalidates that group; an id reused across two
// groups keeps only the first, valid claim — the second is dropped entirely, and nothing is
// double-counted or duplicated across groups.
{
  const modelOutput = [
    { ids: ['a', 'b'], text: 'نشرت 2 ستوريز' },
    { ids: ['b', 'c'], text: 'نشرت 2 ستوريز' }, // 'b' already used above
    { ids: ['z', 'c'], text: 'نشرت 2 ستوريز' }, // 'z' does not exist
  ];
  const validation = validateOutput(modelOutput, 'brief', input);
  if (!validation.ok) throw new Error('validateOutput must never reject the whole stage.');
  const groups = (validation.value as { groups: { ids: string[]; text: string }[] }).groups;
  const merged = groups.filter((g) => g.ids.length > 1);
  if (merged.length !== 1 || merged[0].ids.slice().sort().join(',') !== 'a,b') {
    throw new Error('A reused or invented id must invalidate every later group that references it, keeping only the first valid claim.');
  }
  if (groups.reduce((sum, g) => sum + g.ids.length, 0) !== items.length) throw new Error('Every input id must still appear exactly once overall.');
}

// 6) Completely malformed/non-array model output degrades to every item as its own untouched
// singleton — never a thrown error, never a dropped item.
{
  for (const malformed of [null, 'not json', { not: 'an array' }, []]) {
    const validation = validateOutput(malformed, 'brief', input);
    if (!validation.ok) throw new Error('Malformed model output must degrade to singletons, never fail the whole stage.');
    const groups = (validation.value as { groups: { ids: string[]; text: string }[] }).groups;
    if (groups.length !== items.length || groups.some((g) => g.ids.length !== 1)) {
      throw new Error('Malformed model output must produce exactly one untouched singleton per input item.');
    }
  }
}

// 7) The model's stated count is correct, but it still used the banned trailing-count shape
// ("posted a story 5 times" / "... 5 مرات") instead of putting the count next to the noun. The
// system prompt already tells it never to do this — this is the deterministic backstop for when
// it does anyway: the whole group is discarded, same fallback as every other failed check above.
{
  const modelOutput = [{ ids: ['a', 'b', 'c'], text: 'نشرت ستوري 3 مرات' }]; // correct count, banned shape
  const validation = validateOutput(modelOutput, 'brief', input);
  if (!validation.ok) throw new Error('validateOutput must never reject the whole stage.');
  const groups = (validation.value as { groups: { ids: string[]; text: string }[] }).groups;
  if (groups.some((g) => g.ids.length > 1)) throw new Error('A group phrased with a trailing "مرات" clause must be discarded, even with a correct count.');
}
{
  const modelOutput = [{ ids: ['a', 'b', 'c'], text: 'posted a story 3 times' }]; // English equivalent
  const validation = validateOutput(modelOutput, 'brief', input);
  if (!validation.ok) throw new Error('validateOutput must never reject the whole stage.');
  const groups = (validation.value as { groups: { ids: string[]; text: string }[] }).groups;
  if (groups.some((g) => g.ids.length > 1)) throw new Error('A group phrased with a trailing "times" clause must be discarded, even with a correct count.');
}
{
  // The correct shape (count placed next to the noun, no "مرات"/"times") must still be accepted.
  const modelOutput = [{ ids: ['a', 'b', 'c'], text: 'نشرت 3 ستوري' }];
  const validation = validateOutput(modelOutput, 'brief', input);
  if (!validation.ok) throw new Error('A valid, correctly-counted group was rejected.');
  const groups = (validation.value as { groups: { ids: string[]; text: string }[] }).groups;
  if (!groups.some((g) => g.ids.length === 3)) throw new Error('A correctly-phrased group (count before the noun, no banned words) must be accepted.');
}

// Payload-level validation: cap, shape, and uniqueness (mirrors CAMPAIGN_SUMMARY's own work_items
// regressions in checkCampaignSummaryWorkItems.ts).
{
  let rejected = false;
  try { validateWorkItemGroupPayload({ items: [] }); } catch { rejected = true; }
  if (!rejected) throw new Error('An empty items array must be rejected.');
}
{
  let rejected = false;
  try { validateWorkItemGroupPayload({ items: Array.from({ length: 61 }, (_, i) => ({ id: String(i), text: 'x' })) }); } catch { rejected = true; }
  if (!rejected) throw new Error('An oversized items batch (>60) must be rejected.');
}
{
  let rejected = false;
  try { validateWorkItemGroupPayload({ items: [{ id: 'a', text: 'x' }, { id: 'a', text: 'y' }] }); } catch { rejected = true; }
  if (!rejected) throw new Error('Duplicate item ids must be rejected.');
}
{
  let rejected = false;
  try { validateWorkItemGroupPayload({ items: [{ id: 'a', text: 'x', unexpected: 'y' }] }); } catch { rejected = true; }
  if (!rejected) throw new Error('An unknown field inside an item must be rejected.');
}

console.log('OK: WORK_ITEM_GROUP never trusts the model\'s stated count, employee match, or ids — every merge is independently re-verified and any failure degrades to untouched singletons.');
