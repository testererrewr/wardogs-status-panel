// Custom bot status is observational: an unavailable runner must never be
// interpreted as a stopped/missing bot or trigger any container mutation.
export function statusFailureKind(error) {
  const text = String(error?.message || error || '');
  if (/RUNNER_SHARED_SECRET|runner.*secret|forbidden|Runner HTTP 403/i.test(text)) return 'runner_configuration';
  if (/permission denied|operation not permitted|access.*denied/i.test(text)) return 'docker_permissions';
  if (/cannot connect to the docker daemon|docker daemon.*not running|error during connect|docker\.sock.*(connect|refused)/i.test(text)) return 'docker_unavailable';
  if (/timeout|timed out|aborted|AbortError/i.test(text)) return 'timeout';
  if (/fetch failed|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|runner.*unavailable|Runner HTTP 50[0234]/i.test(text)) return 'runner_unavailable';
  return 'status_query_failed';
}

function validStatus(value) {
  if (!value || typeof value !== 'object' || typeof value.exists !== 'boolean' || typeof value.running !== 'boolean') return null;
  return { exists: value.exists, running: value.running };
}

/**
 * One fast batch call for the normal case. If that single Docker request fails,
 * inspect requested containers separately (bounded, without ever changing state).
 * A problem stays 'unknown', never 'stopped'.
 */
export async function resolveCustomBotStatuses(bots, { batch, individual }, { maxFallback = 12, concurrency = 4 } = {}) {
  const unique = [...new Map((bots || []).filter((bot) => bot?.id).map((bot) => [bot.id, bot])).values()];
  const statuses = {};
  if (!unique.length) return { statuses, degraded: false };
  let batchFailure = null;
  try {
    const result = await batch(unique);
    if (!result || typeof result.statuses !== 'object' || result.statuses === null || Array.isArray(result.statuses)) {
      throw new Error('runner returned an invalid status response');
    }
    for (const bot of unique) {
      const value = validStatus(result.statuses[bot.id]);
      if (value) statuses[bot.id] = value;
    }
  } catch (error) {
    batchFailure = statusFailureKind(error);
  }

  const missing = unique.filter((bot) => !statuses[bot.id]);
  if (!missing.length) return { statuses, degraded: false };
  if (missing.length > maxFallback) {
    for (const bot of missing) statuses[bot.id] = { unknown: true, reason: batchFailure || 'status_query_failed' };
    return { statuses, degraded: true };
  }

  let position = 0;
  const worker = async () => {
    while (position < missing.length) {
      const bot = missing[position++];
      try {
        const result = await individual(bot);
        const value = validStatus(result);
        statuses[bot.id] = value || { unknown: true, reason: 'status_query_failed' };
      } catch (error) {
        statuses[bot.id] = { unknown: true, reason: statusFailureKind(error) };
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, missing.length) }, worker));
  return { statuses, degraded: Object.values(statuses).some((status) => status.unknown === true) };
}
