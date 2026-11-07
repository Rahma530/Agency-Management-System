// Phase 2/3: the generic multi-stage task runner. Reads a TaskDefinition (taskRegistry.ts) and
// executes its stages in order — this is the "dispatch code" that a new registry entry should
// never need to change. A task may define any number of stages (one, two, or more) with no
// special-casing here — see taskRegistry.ts's header comment for when a task needs more than one.
// Execution model: within a stage, its provider order (TaskStageDefinition.providers(), possibly
// more than one fallback) is tried in sequence, skipping any candidate currently in cooldown
// (public.ai_provider_state, checked in one batched query per stage — see providers/cooldown.ts)
// and moving to the next only after a real attempt returns ok:false. Every real attempt — success
// or failure — is logged to public.ai_usage (providers/usageLog.ts); a skipped, in-cooldown
// candidate gets no network call and no usage row.
import { callProvider, resolveProviderModel } from './providers/dispatch.ts';
import { checkCooldowns, cooldownId, recordCooldown } from './providers/cooldown.ts';
import { recordUsage } from './providers/usageLog.ts';
import { AiProviderError, AiProvider, AiRateLimitReason, RateLimitHeaders } from './types.ts';
import { DetailLevel, SupportedLanguage, TaskDefinition, TaskStageDefinition } from './taskRegistry.ts';
import { createClient } from 'npm:@supabase/supabase-js@2.114.0';

type AdminClient = ReturnType<typeof createClient>;

export interface StageOutcome {
  stage: string;
  provider: AiProvider;
  model: string;
  usedFallback: boolean;
}

export interface TaskFailure {
  ok: false;
  task: string;
  stage: string;
  kind: 'rate_limit' | 'error';
  reason?: string;
  message: string;
  rateLimitHeaders?: RateLimitHeaders;
  limitSource?: string;
}

export type RunTaskResult =
  | { ok: true; task: string; result: unknown; stages: StageOutcome[] }
  | TaskFailure;

// Models are told never to wrap output in markdown fences (see both system prompts in
// taskRegistry.ts), but a cheap defensive strip of a leading/trailing ``` fence costs nothing and
// guards against the common case of a model doing it anyway.
function stripCodeFence(text: string): string {
  const trimmed = text.trim();
  const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(trimmed);
  return fenced ? fenced[1] : trimmed;
}

type StageAttemptResult =
  | { ok: true; text: string; provider: AiProvider; model: string; usedFallback: boolean }
  | { ok: false; kind: 'rate_limit' | 'error'; reason?: string; message: string; rateLimitHeaders?: RateLimitHeaders; limitSource?: string };

function toFailure(err: unknown): Extract<StageAttemptResult, { ok: false }> {
  if (err instanceof AiProviderError) {
    return { ok: false, kind: err.kind, reason: err.reason, message: err.message, rateLimitHeaders: err.rateLimitHeaders, limitSource: err.limitSource };
  }
  return { ok: false, kind: 'error', message: err instanceof Error ? err.message : String(err) };
}

async function runStage(
  stage: TaskStageDefinition,
  inputText: string,
  language: SupportedLanguage,
  detail: DetailLevel,
  admin: AdminClient,
  taskName: string,
  requestId: string
): Promise<StageAttemptResult> {
  // stage.providers() can throw (e.g. CAMPAIGN_SUMMARY_ANALYZE_ORDER set to an invalid value) —
  // caught the same way a provider call's own failure is, so a misconfigured order fails this one
  // stage, not the whole request path. Nothing to log to ai_usage here: no candidate was even
  // resolved yet.
  let providerOrder: AiProvider[];
  try {
    providerOrder = stage.providers();
  } catch (err) {
    return toFailure(err);
  }

  // Resolve each candidate's configured model up front (needed for both the cooldown lookup key
  // and, on failure, the usage log row) and batch-check cooldown state in one query rather than
  // one per provider.
  const candidates = providerOrder.map((provider) => ({ provider, model: resolveProviderModel(provider) }));
  const ids = candidates.filter((c) => c.model).map((c) => cooldownId(c));
  const inCooldown = await checkCooldowns(admin, ids);

  const systemPrompt = stage.systemPrompt(language, detail);
  const maxOutputTokens = stage.maxOutputTokens(detail);

  let lastFailure: Extract<StageAttemptResult, { ok: false }> | null = null;
  let attempted = false;
  for (let i = 0; i < candidates.length; i++) {
    const { provider, model } = candidates[i];
    // An unconfigured provider (model === '') has no meaningful cooldown key — let callProvider
    // raise its own clear "not configured" error below rather than silently treating a
    // misconfiguration as if it were just rate-limited.
    if (model && inCooldown.has(cooldownId({ provider, model }))) continue;

    attempted = true;
    try {
      const result = await callProvider(provider, { prompt: inputText, systemPrompt, maxOutputTokens });
      await recordUsage(admin, {
        provider,
        model: result.model,
        task: taskName,
        stage: stage.name,
        ok: true,
        inputTokens: result.inputTokens,
        outputTokens: result.outputTokens,
        totalTokens: result.totalTokens,
        thoughtsTokens: result.thoughtsTokens,
        requestId,
      });
      return { ok: true, text: result.text, provider: result.provider, model: result.model, usedFallback: i > 0 };
    } catch (err) {
      // Move to the next provider in the order only after this one returns ok:false (throws) — the
      // last one's failure is what gets reported if every candidate is exhausted, since it's the
      // most recent, most relevant signal for why the stage ultimately failed.
      const failure = toFailure(err);
      lastFailure = failure;
      await recordUsage(admin, {
        provider,
        model: model || null,
        task: taskName,
        stage: stage.name,
        ok: false,
        kind: failure.kind,
        reason: failure.reason,
        limitSource: failure.limitSource,
        requestId,
      });
      // Cooldown state is written only on a genuine 429 — never for a non-rate-limit error (a
      // misconfigured key, a 503, a network failure) and never on success.
      if (failure.kind === 'rate_limit' && model) {
        await recordCooldown(admin, {
          provider,
          model,
          reason: failure.reason as AiRateLimitReason | undefined,
          limitSource: failure.limitSource,
          rateLimitHeaders: failure.rateLimitHeaders,
        });
      }
    }
  }
  if (!attempted) {
    return { ok: false, kind: 'error', message: `${stage.name}: every configured provider is currently in cooldown.` };
  }
  return lastFailure ?? { ok: false, kind: 'error', message: `${stage.name} has no configured providers.` };
}

export async function runRegistryTask(
  task: TaskDefinition,
  rawPayload: unknown,
  language: SupportedLanguage,
  detail: DetailLevel,
  admin: AdminClient,
  requestId: string
): Promise<RunTaskResult> {
  let currentInput: unknown;
  try {
    currentInput = task.buildInitialInput(rawPayload);
  } catch (err) {
    return {
      ok: false,
      task: task.name,
      stage: task.stages[0]?.name || 'INPUT',
      kind: 'error',
      message: err instanceof Error ? err.message : String(err),
    };
  }

  const stages: StageOutcome[] = [];

  for (const stage of task.stages) {
    const inputText = JSON.stringify(currentInput);

    // A provider's API call can succeed while the TEXT it returns still fails to parse as JSON or
    // fails this stage's own validateOutput (schema shape, or a grounding check like
    // STRUCTURED_CLIENT_REPORT's "every number in the output must already occur in the input") —
    // a content-quality miss, not an API failure. Before this fix, that one miss from whichever
    // provider answered first (almost always the fastest/first-in-order one) failed the ENTIRE
    // task outright, even though the stage's other configured providers were never even tried —
    // confirmed as the exact cause of the "AI Summary" button's "STRUCTURE stage produced output
    // that did not match the expected schema" failure the owner hit (2026-11-07). Retrying with
    // the next provider, excluding whichever one just produced the bad output, gives every
    // configured provider in this stage's order a real chance before the stage gives up — bounded
    // by that provider count so this can never loop more than once per configured provider.
    let maxAttempts: number;
    try {
      maxAttempts = Math.max(stage.providers().length, 1);
    } catch {
      maxAttempts = 1; // stage.providers() itself throwing is handled by runStage's own try/catch below.
    }

    const excludedProviders: AiProvider[] = [];
    let lastContentFailureMessage: string | null = null;
    let validatedValue: unknown;
    let succeeded = false;

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      const stageForAttempt: TaskStageDefinition = excludedProviders.length
        ? { ...stage, providers: () => stage.providers().filter((p) => !excludedProviders.includes(p)) }
        : stage;
      const outcome = await runStage(stageForAttempt, inputText, language, detail, admin, task.name, requestId);

      if (!outcome.ok) {
        // A genuine API-level failure (rate limit, network, misconfiguration, or — once
        // excludedProviders has removed every candidate — none left to try) — not something
        // excluding a provider and retrying would fix differently, so this ends the stage exactly
        // as it always has.
        return { ok: false, task: task.name, stage: stage.name, ...outcome };
      }
      stages.push({ stage: stage.name, provider: outcome.provider, model: outcome.model, usedFallback: outcome.usedFallback });

      if (stage.outputFormat !== 'json') {
        validatedValue = outcome.text;
        succeeded = true;
        break;
      }

      let parsed: unknown;
      try {
        parsed = JSON.parse(stripCodeFence(outcome.text));
      } catch {
        lastContentFailureMessage = `${stage.name} stage produced invalid JSON.`;
        excludedProviders.push(outcome.provider);
        continue;
      }

      // Applies to whichever provider actually answered — primary or fallback — since a fallback
      // model can just as easily produce syntactically valid but wrongly-shaped JSON. Never passes
      // an unvalidated result on to the next stage or back to the caller.
      if (stage.validateOutput) {
        const validation = stage.validateOutput(parsed, detail, currentInput);
        if (!validation.ok) {
          lastContentFailureMessage = `${stage.name} stage produced output that did not match the expected schema.`;
          excludedProviders.push(outcome.provider);
          continue;
        }
        validatedValue = validation.value;
      } else {
        validatedValue = parsed;
      }
      succeeded = true;
      break;
    }

    if (!succeeded) {
      // Every configured provider for this stage was tried and each one's output either failed to
      // parse or failed validation — the exact same failure shape as before this fix, just only
      // returned once nothing was left to try. lastContentFailureMessage is always set by this
      // point (every `continue` above sets it before looping), the fallback text only guards
      // against a future edit to this loop leaving it unset.
      return {
        ok: false,
        task: task.name,
        stage: stage.name,
        kind: 'error',
        message: lastContentFailureMessage || `${stage.name} stage produced output that did not match the expected schema.`,
      };
    }

    currentInput = validatedValue;
  }

  return { ok: true, task: task.name, result: currentInput, stages };
}
