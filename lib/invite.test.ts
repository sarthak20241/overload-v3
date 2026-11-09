import { assertEquals } from 'jsr:@std/assert';
import { readMyReferral, redeemFailureCopy, referralLink, referralShareMessage, referralTally, storeRedeemUrl } from './invite.ts';

Deno.test('store discount codes go to the right store, code filled in', () => {
  assertEquals(storeRedeemUrl(' spring-25 ', 'ios'), 'https://apps.apple.com/redeem?ctx=offercodes&id=6773063775&code=SPRING25');
  assertEquals(storeRedeemUrl('spring25', 'android'), 'https://play.google.com/redeem?code=SPRING25');
});

Deno.test('the share text carries the link', () => {
  assertEquals(referralLink('ab c12'), 'https://tryoverload.app/i/ABC12');
  assertEquals(referralShareMessage('ABC123').endsWith('https://tryoverload.app/i/ABC123'), true);
});

Deno.test('my referral: ok, refused, network', () => {
  assertEquals(readMyReferral({ ok: true, code: 'ABC123', friends: 2, paying: false }, null), { ok: true, code: 'ABC123', friends: 2, paying: false });
  assertEquals(readMyReferral({ ok: false, reason: 'no_profile' }, null), { ok: false, reason: 'no_profile' });
  assertEquals(readMyReferral(null, new Error('x')), { ok: false, reason: 'network' });
});

Deno.test('tally: a paying sharer is not promised months', () => {
  assertEquals(referralTally(0, false), 'No friends have joined yet.');
  assertEquals(referralTally(1, false), '1 friend has joined. You earned 1 free month.');
  assertEquals(referralTally(3, true), '3 friends have joined. Thank you.');
});

Deno.test('new refusal reasons have their own words', () => {
  assertEquals(redeemFailureCopy('own_code').startsWith("That's your own code"), true);
  assertEquals(redeemFailureCopy('expired'), 'This code has ended.');
});
