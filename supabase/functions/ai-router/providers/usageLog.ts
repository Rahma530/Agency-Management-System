// Phase 3: per-attempt usage log against public.ai_usage. Every real provider call this router
// makes gets exactly one row here, success or failure — both the Task Registry path
// (taskRunner.ts) and the PHASE1_TEST_* diagnostic path (index.ts) log here, so ai_usage reflects
// true total usage regardless of which path made the call. A cooldown-skipped candidate (never
// actually called) gets no row — see cooldown.ts's checkCooldowns/taskRunner.ts's runStage.
import { createClient } from 'npm:@supabase/supabase-js@2.114.0';
import { AiErrorKind, AiProvider, AiRateLimitReason } from '../types.ts';

type AdminClient = ReturnType<typeof createClient>;

export interface UsageRecord {
  provider: AiProvider;
  // null when a call never resolved a model at all (e.g. an unconfigured provider); undefined
  // treated the same as null.
  model?: string | null;
  task: string;
  // null for the PHASE1_TEST_* path (it has no stages).
  stage?: string | null;
  ok: boolean;
  kind?: AiErrorKind | null;
  reason?: AiRateLimitReason | string | null;
  limitSource?: string | null;
  inputTokens?: number | null;
  outputTokens?: number | null;
  totalTokens?: number | null;
  thoughtsTokens?: number | null;
  requestId: string | null;
}

// Never throws: a logging failure here must not turn an otherwise-successful AI response into a
// failed request. Call sites still await this, since Deno Edge Functions can kill unawaited work
// once the response has been returned.
export async function recordUsage(admin: AdminClient, record: UsageRecord): Promise<void> {
  try {
    const { error } = await admin.from('ai_usage').insert({
      id: crypto.randomUUID(),
      provider: record.provider,
      model: record.model ?? null,
      task: record.task,
      stage: record.stage ?? null,
      ok: record.ok,
      kind: record.kind ?? null,
      reason: record.reason ?? null,
      limit_source: record.limitSource ?? null,
      input_tokens: record.inputTokens ?? null,
      output_tokens: record.outputTokens ?? null,
      total_tokens: record.totalTokens ?? null,
      thoughts_tokens: record.thoughtsTokens ?? null,
      request_id: record.requestId,
    });
    if (error) console.error('ai-router recordUsage insert failed:', error.message);
  } catch (err) {
    console.error('ai-router recordUsage threw:', err instanceof Error ? err.message : String(err));
  }
}
