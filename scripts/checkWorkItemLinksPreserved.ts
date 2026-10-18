// Point ب's extra requirement: AI Summary must never change a work_item's link. This checks the
// whole client-side pipeline end to end — buildCampaignSummaryPayload strips `links` before it
// ever reaches the (here, mocked) ai-router call, and runWorkItemBatches reattaches it afterward
// by id, unchanged, whether that batch's call succeeds or fails outright.
import {
  buildCampaignSummaryPayload,
  runWorkItemBatches,
  CampaignSummaryWorkItem,
  CampaignSummaryGenerationResult,
} from '../src/components/reporting/ComparisonDisplay';
import { ClientComparisonRecord } from '../src/types/database';

const comparison = {
  id: 'cmp-1',
  client_id: 'client-1',
  period_current: '2026-10',
  period_previous: '2026-09',
  metrics_current: { media_buying: { spend: 100, roas: 2, conversions: 10, cpa: 10 } },
  metrics_previous: { media_buying: { spend: 90, roas: 1.8, conversions: 9, cpa: 10 } },
  delta: {},
} as unknown as ClientComparisonRecord;

const LINK = 'https://docs.google.com/document/d/abc123/edit';

const workItems: CampaignSummaryWorkItem[] = [
  { id: 'a', employee: 'Sara', text: 'رفعت سارة الملف للعميل.', links: [LINK] },
  { id: 'b', employee: 'Omar', text: 'نشر عمر المحتوى بدون أي رابط.' },
];

// 1) buildCampaignSummaryPayload must never leak `links` into the wire payload, for any item.
{
  const payload = buildCampaignSummaryPayload(comparison, undefined, undefined, workItems);
  const wireItems = payload.work_items as unknown as Record<string, unknown>[];
  if (!wireItems || wireItems.length !== 2) throw new Error('work_items were not carried into the payload.');
  if (wireItems.some((item) => 'links' in item)) {
    throw new Error('buildCampaignSummaryPayload leaked the client-only "links" field into the wire payload.');
  }
}

// 2) A successful batch: the model "rephrases" item a's text completely (no link in its output,
// since it never saw one) — the final text must still contain the original link, unchanged.
{
  const call = async (batch: CampaignSummaryWorkItem[]): Promise<CampaignSummaryGenerationResult> => ({
    ok: true,
    result: {
      summary: 'ملخص.',
      by_service: [],
      recommendations: [],
      work_items: batch.map((item) => ({ id: item.id, text: `إعادة صياغة كاملة لِـ ${item.id}` })),
    },
  });
  const { items } = await runWorkItemBatches(workItems, call);
  const byId = new Map(items.map((i) => [i.id, i.text]));
  if (!byId.get('a')?.includes(LINK)) throw new Error('A successful batch lost item a\'s link after rephrasing.');
  if (byId.get('a') === 'رفعت سارة الملف للعميل.') throw new Error('Item a was not actually rephrased — test is not exercising the rewrite path.');
  if (byId.get('b')?.includes('https://')) throw new Error('A link was fabricated for item b, which never had one.');
}

// 3) A batch that fails outright (both the live attempt and its one retry) must still fall back
// to item a's own ORIGINAL text WITH its link intact — never dropped.
{
  const call = async (): Promise<CampaignSummaryGenerationResult> => ({ ok: false, message: 'down' });
  const { items, anyBatchFellBack } = await runWorkItemBatches(workItems, call);
  if (!anyBatchFellBack) throw new Error('A fully-failed batch should report anyBatchFellBack=true.');
  const byId = new Map(items.map((i) => [i.id, i.text]));
  if (!byId.get('a')?.includes(LINK)) throw new Error('A failed-batch fallback lost item a\'s link.');
}

console.log('OK: a work_item\'s link is stripped before ai-router ever sees it, and reattached unchanged afterward — on both a successful rephrase and a fully-failed batch\'s fallback.');
