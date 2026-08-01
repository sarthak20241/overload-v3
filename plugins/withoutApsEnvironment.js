/**
 * Strips the `aps-environment` entitlement that expo-notifications injects.
 *
 * expo-notifications ships a config plugin that Expo applies automatically via
 * autolinking — just installing the package adds `aps-environment` to the iOS
 * entitlements, whether or not the app uses remote push. We don't: lib/notifications.ts
 * only schedules the day-5 local trial reminder, and says so ("Local scheduling
 * (not server push) on purpose: no push infra exists yet"). Local notifications
 * need user permission, not APNs.
 *
 * Leaving the entitlement in makes EAS Build demand the Push Notifications
 * capability on the provisioning profile, which fails signing outright:
 *
 *   Provisioning profile "*[expo] com.overload.tracker AppStore ..."
 *   doesn't support the Push Notifications capability.
 *   doesn't include the aps-environment entitlement.
 *
 * That's what killed iOS build 52 — the profile dates from 2026-05-25, long
 * before expo-notifications arrived in #81. The choice is to widen the Apple
 * App ID with a capability the app never exercises, or drop the entitlement.
 * Dropping it keeps the app identity honest and the existing profile valid.
 *
 * When we do add real push (server-driven nudges), remove this plugin AND
 * enable Push Notifications on the App ID, then regenerate the profile.
 */
const { withEntitlementsPlist } = require('expo/config-plugins');

module.exports = function withoutApsEnvironment(config) {
  return withEntitlementsPlist(config, (cfg) => {
    delete cfg.modResults['aps-environment'];
    return cfg;
  });
};
