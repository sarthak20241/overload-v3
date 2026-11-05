import { assertEquals, assertRejects } from 'jsr:@std/assert@1';
import { OnboardingHttpError, requestOnboardingProgramSignedIn } from './onboardingPlanRoute.ts';

Deno.test('a Pro user keeps the signed-in path', async () => {
  let guestCalls = 0;
  const res = await requestOnboardingProgramSignedIn(
    () => Promise.resolve('authed-program'),
    () => { guestCalls++; return Promise.resolve('guest-program'); },
  );
  assertEquals(res, { program: 'authed-program', via: 'authed' });
  assertEquals(guestCalls, 0);
});

Deno.test('a free user (402 pro_required) gets the guest path program', async () => {
  const res = await requestOnboardingProgramSignedIn(
    () => Promise.reject(new OnboardingHttpError(402)),
    () => Promise.resolve('guest-program'),
  );
  assertEquals(res, { program: 'guest-program', via: 'guest_after_402' });
});

Deno.test('other failures still throw, so the deterministic plan is used', async () => {
  let guestCalls = 0;
  await assertRejects(() =>
    requestOnboardingProgramSignedIn(
      () => Promise.reject(new OnboardingHttpError(500)),
      () => { guestCalls++; return Promise.resolve('guest-program'); },
    ),
  );
  await assertRejects(() =>
    requestOnboardingProgramSignedIn(
      () => Promise.reject(new Error('timeout')),
      () => { guestCalls++; return Promise.resolve('guest-program'); },
    ),
  );
  assertEquals(guestCalls, 0);
});

Deno.test('a failed guest call after a 402 throws too', async () => {
  await assertRejects(() =>
    requestOnboardingProgramSignedIn(
      () => Promise.reject(new OnboardingHttpError(402)),
      () => Promise.reject(new Error('HTTP 429')),
    ),
  );
});
