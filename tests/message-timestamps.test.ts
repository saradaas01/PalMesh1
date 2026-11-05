import assert from 'node:assert/strict';
import { test } from 'node:test';
import { formatMessageTimestamps } from '../src/shared/time/messageTimestamps';

const sent = Date.UTC(2026, 10, 5, 10, 0);
const received = Date.UTC(2026, 10, 5, 10, 25);

test('delayed delivery preserves sender time while formatting receipt independently', () => {
  const input = Object.freeze({ createdAt: sent, receivedAt: received });
  const result = formatMessageTimestamps(input, { locale: 'en-GB', timeZone: 'UTC' });
  assert.equal(result.sent, '5 Nov 2026, 10:00');
  assert.equal(result.received, '5 Nov 2026, 10:25');
  assert.equal(result.clockIssue, null);
  assert.equal(input.createdAt, sent);
  assert.equal(input.receivedAt, received);
  assert.equal(Object.isFrozen(result), true);
});

test('timezone conversion uses the same original instant and follows locale 12/24-hour defaults', () => {
  assert.equal(formatMessageTimestamps({ createdAt: sent }, { locale: 'en-US', timeZone: 'America/New_York' }).sent,
    'Nov 5, 2026, 5:00 AM');
  assert.equal(formatMessageTimestamps({ createdAt: sent }, { locale: 'en-GB', timeZone: 'Asia/Amman' }).sent,
    '5 Nov 2026, 13:00');
  const arabic = formatMessageTimestamps({ createdAt: sent }, { locale: 'ar-JO', timeZone: 'Asia/Amman' }).sent;
  assert.equal(arabic, new Intl.DateTimeFormat('ar-JO', {
    timeZone: 'Asia/Amman', year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
  }).format(sent));
});

test('omitted locale and timezone follow the device Intl defaults without forcing an hour cycle', () => {
  const expected = new Intl.DateTimeFormat(undefined, {
    year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
  }).format(sent);
  assert.equal(formatMessageTimestamps({ createdAt: sent }).sent, expected);
});

test('a future sender clock is flagged without replacing or adjusting its original timestamp', () => {
  const result = formatMessageTimestamps({ createdAt: received + 30 * 60_000, receivedAt: received },
    { locale: 'en-GB', timeZone: 'UTC' });
  assert.equal(result.clockIssue, 'ahead-of-receipt');
  assert.equal(result.sent, '5 Nov 2026, 10:55');
  assert.equal(result.received, '5 Nov 2026, 10:25');
  assert.equal(formatMessageTimestamps({ createdAt: received + 5 * 60_000, receivedAt: received }).clockIssue, null);
});

test('long offline delays are not clock skew and original times remain stable on history restoration', () => {
  const original = { createdAt: sent, receivedAt: received + 30 * 86_400_000 };
  const options = { locale: 'en-GB', timeZone: 'Asia/Amman' };
  const before = formatMessageTimestamps(original, options);
  const after = formatMessageTimestamps(JSON.parse(JSON.stringify(original)), options);
  assert.deepEqual(after, before);
  assert.equal(after.clockIssue, null);
  assert.equal(after.sent, '5 Nov 2026, 13:00');
});

test('implausible but representable sender dates remain explicit and flagged', () => {
  const result = formatMessageTimestamps({ createdAt: 0, receivedAt: received }, { locale: 'en-GB', timeZone: 'UTC' });
  assert.equal(result.clockIssue, 'implausible');
  assert.equal(result.sent, '1 Jan 1970, 0:00');
  assert.equal(formatMessageTimestamps({ createdAt: Date.UTC(12_000, 0, 1) }).clockIssue, 'implausible');
});

test('invalid sender timestamps never become receipt timestamps or crash history', () => {
  for (const createdAt of [undefined, null, '2026-11-05', NaN, Infinity, -1, 1.5, Number.MAX_SAFE_INTEGER]) {
    const result = formatMessageTimestamps({ createdAt, receivedAt: received }, { locale: 'en-GB', timeZone: 'UTC' });
    assert.equal(result.sent, null);
    assert.equal(result.received, '5 Nov 2026, 10:25');
    assert.equal(result.clockIssue, 'invalid');
  }
  assert.equal(formatMessageTimestamps({ createdAt: sent, receivedAt: NaN }).received, null);
});

test('unsupported timezone formatting fails safely without inventing a fallback timestamp', () => {
  assert.deepEqual(formatMessageTimestamps({ createdAt: sent, receivedAt: received }, { timeZone: 'Not/A_Zone' }),
    { sent: null, received: null, clockIssue: null });
});
