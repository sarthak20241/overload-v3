import { assertEquals } from 'jsr:@std/assert';
import { APP_STORE_ID, readMyReferral, referralLoadError, redeemFailureCopy, referralLink, referralShareMessage, referralTally, storeRedeemUrl } from './invite.ts';

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
