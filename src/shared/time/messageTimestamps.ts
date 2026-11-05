/** A signed timestamp identifies what the sender's clock claimed, not when an
 * event happened in the real world. Receipt time remains separate local data. */
export interface MessageTimestampInput {
  readonly createdAt: unknown;
  readonly receivedAt?: unknown;
}

export interface MessageTimestampFormatOptions {
  /** Omit in the app to follow the device's locale and default 12/24-hour cycle. */
  readonly locale?: string;
  /** Omit in the app to use the device's local timezone. Useful in tests. */
  readonly timeZone?: string;
}

export interface FormattedMessageTimestamps {
  readonly sent: string | null;
  readonly received: string | null;
  readonly clockIssue: 'invalid' | 'implausible' | 'ahead-of-receipt' | null;
}

const MAX_DATE_TIMESTAMP = 8_640_000_000_000_000;
const EARLIEST_PLAUSIBLE_MESSAGE = Date.UTC(2000, 0, 1);
const LATEST_PLAUSIBLE_MESSAGE = Date.UTC(10_000, 0, 1);
const CLOCK_SKEW_TOLERANCE_MS = 5 * 60_000;

function timestamp(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value)
    && value >= 0 && value <= MAX_DATE_TIMESTAMP ? value : null;
}

/** Format the original value without correcting it, substituting receipt time,
 * or mutating signed fields. Old messages may have been delayed for any length
 * of time, so elapsed delivery time alone is never classified as clock skew. */
export function formatMessageTimestamps(
  input: MessageTimestampInput,
  options: MessageTimestampFormatOptions = {},
): FormattedMessageTimestamps {
  const sentAt = timestamp(input.createdAt);
  const receivedAt = timestamp(input.receivedAt);
  const clockIssue = sentAt === null ? 'invalid'
    : sentAt < EARLIEST_PLAUSIBLE_MESSAGE || sentAt >= LATEST_PLAUSIBLE_MESSAGE ? 'implausible'
      : receivedAt !== null && sentAt - receivedAt > CLOCK_SKEW_TOLERANCE_MS ? 'ahead-of-receipt' : null;
  try {
    const formatter = new Intl.DateTimeFormat(options.locale, {
      year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
      ...(options.timeZone ? { timeZone: options.timeZone } : {}),
    });
    return Object.freeze({
      sent: sentAt === null ? null : formatter.format(sentAt),
      received: receivedAt === null ? null : formatter.format(receivedAt),
      clockIssue,
    });
  } catch {
    // An unsupported Intl implementation or bad locale must not crash history,
    // invent a time, or unexpectedly fall back to a different timezone.
    return Object.freeze({ sent: null, received: null, clockIssue });
  }
}
