import { assertEquals } from 'jsr:@std/assert';
import { APP_STORE_ID, APPLE_FRIEND_OFFER_CODE, appleLinkedSummary, friendMonthFromStore, inviteIntroCopy, appliedSummary, grantSpan, readMyReferral, readRedeemResult, referralLoadError, redeemFailureCopy, referralLink, referralShareMessage, referralTally, storeRedeemUrl } from './invite.ts';

Deno.test('store discount codes go to the right store, code filled in', () => {
  assertEquals(storeRedeemUrl(' spring-25 ', 'ios'), 'https://apps.apple.com/redeem?ctx=offercodes&id=6773063775&code=SPRING25');
  assertEquals(storeRedeemUrl('spring25', 'android'), 'https://play.google.com/redeem?code=SPRING25');
});

Deno.test('the share text carries the link', () => {
  assertEquals(referralLink('ab c12'), 'https://tryoverload.app/i/ABC12');
  assertEquals(referralShareMessage('ABC123').endsWith('https://tryoverload.app/i/ABC123'), true);
  assertEquals(referralShareMessage('ABC123').includes('we both get'), true);
  assertEquals(referralShareMessage('ABC123', true).includes('we both'), false);
});

Deno.test('my referral: ok, refused, network', () => {
  assertEquals(readMyReferral({ ok: true, code: 'ABC123', friends: 2, months_earned: 1, paying: false }, null), { ok: true, code: 'ABC123', friends: 2, monthsEarned: 1, paying: false });
  assertEquals(readMyReferral({ ok: false, reason: 'no_profile' }, null), { ok: false, reason: 'no_profile' });
  assertEquals(readMyReferral(null, new Error('x')), { ok: false, reason: 'network' });
});

Deno.test('tally: months are the ones given, not the friend count', () => {
  assertEquals(referralTally(0, 0), 'No friends have joined yet.');
  assertEquals(referralTally(1, 1), '1 friend has joined. You earned 1 free month.');
  assertEquals(referralTally(3, 0), '3 friends have joined. Thank you.');
  assertEquals(referralTally(3, 2), '3 friends have joined. You earned 2 free months.');
});

Deno.test('the App Store id matches eas.json', async () => {
  const eas = JSON.parse(await Deno.readTextFile(new URL('../eas.json', import.meta.url)));
  const ids = JSON.stringify(eas).match(/"ascAppId":"(\d+)"/g) ?? [];
  assertEquals(ids.length > 0, true);
  for (const m of ids) assertEquals(m, `"ascAppId":"${APP_STORE_ID}"`);
});

Deno.test('share screen errors say what to do', () => {
  assertEquals(referralLoadError('no_profile').startsWith('Finish setting up'), true);
  assertEquals(referralLoadError('network').includes('connection'), true);
});

Deno.test('new refusal reasons have their own words', () => {
  assertEquals(redeemFailureCopy('own_code').startsWith("That's your own code"), true);
  assertEquals(redeemFailureCopy('expired'), 'This code has ended.');
});

Deno.test('code applied: what was given, until when, and the friend line', () => {
  const r = readRedeemResult({ ok: true, days: 30, is_owner: false, expires_at: '2026-12-09T10:00:00Z', source: 'referral', owner_rewarded: true }, null);
  if (!r.ok) throw new Error('expected ok');
  const a = appliedSummary(r, 'j9b-qch');
  assertEquals(a.title, 'Code applied.');
  assertEquals(a.rows, [
    { label: 'Code', value: 'J9BQCH' },
    { label: 'You got', value: '1 month of Pro, free' },
    { label: 'Pro until', value: 'December 9, 2026' },
    { label: 'Card', value: 'Not needed. Nothing renews.' },
  ]);
  assertEquals(a.friendLine, 'Your friend got a free month too.');
});

Deno.test('code applied: a campaign code names its own length and no friend', () => {
  const r = readRedeemResult({ ok: true, days: 90, source: 'campaign', owner_rewarded: false }, null);
  if (!r.ok) throw new Error('expected ok');
  const a = appliedSummary(r, 'GYMBUDDY');
  assertEquals(a.rows[1].value, '3 months of Pro, free');
  assertEquals(a.rows.some((x) => x.label === 'Pro until'), false);
  assertEquals(a.friendLine, null);
  assertEquals(grantSpan(45), '45 days');
  // Admin Coupons lengths: 1 year is 365 days, 6 months is 180.
  assertEquals(grantSpan(365), '1 year');
  assertEquals(grantSpan(366), '1 year');
  assertEquals(grantSpan(180), '6 months');
});

Deno.test('iPhone: the friend month comes from Apple, Android keeps ours', () => {
  assertEquals(friendMonthFromStore('ios'), true);
  assertEquals(friendMonthFromStore('android'), false);
  assertEquals(inviteIntroCopy('ios').includes('No card'), false);
  assertEquals(inviteIntroCopy('android').includes('No card'), true);
  // Android codes can be any length (Admin Coupons), so no "a month" promise.
  assertEquals(inviteIntroCopy('android').includes('month'), false);
  const a = appleLinkedSummary('j9b-qch', true);
  assertEquals(a.title, 'Code saved.');
  assertEquals(a.rows[0].value, 'J9BQCH');
  assertEquals(a.friendLine, 'Your friend got a free month too.');
  assertEquals(storeRedeemUrl(APPLE_FRIEND_OFFER_CODE, 'ios').endsWith('code=FRIENDMONTH'), true);
  const o = appleLinkedSummary('OLDAPP2', false, { days: 60, expiresAt: '2027-01-08T00:00:00Z' });
  assertEquals(o.rows.map((r) => r.label), ['Code', 'From your friends', 'Pro until', 'Your free month']);
  assertEquals(o.rows[1].value, '2 months of Pro');
});
