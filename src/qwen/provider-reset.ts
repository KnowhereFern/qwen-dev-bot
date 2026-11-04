/**
 * Strict provider reset-timestamp parsing shared by the direct Qwen API
 * boundary and the supervisor's provider-wait handling. Extracted from
 * supervisor.ts; supervisor re-exports `parseProviderResetAt` so existing
 * import paths stay compatible.
 */

/** Upper bound on a reason inspected for a reset timestamp, so the strict
 * scan never runs over unbounded provider output. */
const PROVIDER_RESET_MAX_REASON_LENGTH = 2_000;
/** Modest safety margin added to an admitted reset so the resumed session
 * lands strictly after the quota is restored. */
export const PROVIDER_RESET_SAFETY_MARGIN_MS = 5 * 60 * 1_000;
/** Provider resets further than this horizon are not admitted; the wait cap
 * matches this horizon. */
export const PROVIDER_RESET_MAX_FUTURE_MS = 32 * 24 * 60 * 60 * 1_000;

// Case-insensitive: providers emit both "reset at" and "Reset at".
const FULL_RESET_PATTERN = /reset at (\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2}))?)? UTC/i;
const YEARLESS_RESET_PATTERN = /reset at (\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2}) UTC/i;

/**
 * Parse a strict provider reset timestamp out of a structured provider
 * reason: either a full `YYYY-MM-DD[ HH:mm[:ss]] UTC` form or a yearless
 * `MM-DD HH:mm:ss UTC` form (as emitted by token-plan quota messages).
 * Yearless values resolve to the next valid UTC occurrence of that calendar
 * moment. Returns the reset epoch milliseconds, or null when the reason is
 * missing, oversized, malformed, not a real calendar date (round-trip
 * verified), in the past, or further than 32 days out. Pure: no clock or
 * store access.
 */
export function parseProviderResetAt(reason: string | null | undefined, now: number): number | null {
  if (typeof reason !== 'string' || reason.length === 0 ||
      reason.length > PROVIDER_RESET_MAX_REASON_LENGTH || !Number.isFinite(now)) {
    return null;
  }
  const full = FULL_RESET_PATTERN.exec(reason);
  if (full) {
    const candidate = utcTimestampStrict(
      Number(full[1]), Number(full[2]), Number(full[3]),
      Number(full[4] ?? '0'), Number(full[5] ?? '0'), Number(full[6] ?? '0'),
    );
    return candidate !== null && admittedResetWindow(candidate, now) ? candidate : null;
  }
  const yearless = YEARLESS_RESET_PATTERN.exec(reason);
  if (yearless) {
    const currentYear = new Date(now).getUTCFullYear();
    for (const year of [currentYear, currentYear + 1]) {
      const candidate = utcTimestampStrict(
        year, Number(yearless[1]), Number(yearless[2]),
        Number(yearless[3]), Number(yearless[4]), Number(yearless[5]),
      );
      if (candidate !== null && admittedResetWindow(candidate, now)) return candidate;
    }
  }
  return null;
}

/** Same length bound as the reset parser: never scan unbounded provider
 * output for quota markers. */
const QUOTA_REASON_MAX_LENGTH = 2_000;

/**
 * Confirm a provider reason describes genuine monthly/token-plan quota
 * exhaustion (as emitted by Qwen token-plan quota messages and
 * `insufficient_quota` API errors). Deliberately narrow: generic rate-limit,
 * overload, network, or incidental quota wording must not trigger a global
 * provider-wide hold. Pure.
 */
export function isMonthlyQuotaExhaustion(reason: string | null | undefined): boolean {
  if (typeof reason !== 'string' || reason.length === 0 || reason.length > QUOTA_REASON_MAX_LENGTH) {
    return false;
  }
  const text = reason.toLowerCase();
  if (text.includes('insufficient_quota')) return true;
  // Month-scoped quota exhaustion only (token-plan "1-month"/"monthly"
  // wording). Generic "quota exceeded"/rate-limit prose must not trigger a
  // provider-wide hold.
  const monthQuota = /(?:^|[^a-z])(?:1[- ]month|monthly)[^\n]{0,120}?quota/;
  const quotaExhausted = /quota[^\n]{0,120}?(?:exhausted|exceeded|used up)/;
  return monthQuota.test(text) && quotaExhausted.test(text);
}

function admittedResetWindow(candidate: number, now: number): boolean {
  // Admit only resets that fit inside the 32-day wait cap MINUS the safety
  // margin. Admitting a reset exactly at the cap would let the capped
  // resumeAfter land at or before resetAt, resuming before the quota is
  // restored; the margin-subtracted bound guarantees resetAt + margin always
  // fits under the cap.
  return candidate > now && candidate - now <= PROVIDER_RESET_MAX_FUTURE_MS - PROVIDER_RESET_SAFETY_MARGIN_MS;
}

/** Date.UTC plus a strict round-trip check so nonexistent calendar moments
 * (e.g. 02-30, 04-31) are rejected instead of silently rolling over. */
function utcTimestampStrict(
  year: number, month: number, day: number, hour: number, minute: number, second: number,
): number | null {
  if (month < 1 || month > 12 || day < 1 || day > 31 ||
      hour > 23 || minute > 59 || second > 59) return null;
  const timestamp = Date.UTC(year, month - 1, day, hour, minute, second);
  const roundTrip = new Date(timestamp);
  if (roundTrip.getUTCFullYear() !== year || roundTrip.getUTCMonth() !== month - 1 ||
      roundTrip.getUTCDate() !== day || roundTrip.getUTCHours() !== hour ||
      roundTrip.getUTCMinutes() !== minute || roundTrip.getUTCSeconds() !== second) {
    return null;
  }
  return timestamp;
}
