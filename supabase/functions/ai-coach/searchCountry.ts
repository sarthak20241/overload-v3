// Which country Precise's web search should favour, from the user's time zone.
//
// Tavily ranks results from one country higher (`country`), and for India we
// also prefer the grocery sites that print pack labels. That is right for our
// users in India and wrong for anyone else: a user in Texas logging "Oreos"
// wants the US pack, not the Indian one. user_profiles.timezone is the one
// location signal we already hold (the app keeps it current), so it decides.
//
// Values are Tavily's own `country` names (its docs, checked 2026-09-27).
// An unknown zone returns null: no boost at all is safer than boosting the
// wrong country. A user with no zone stored gets the fallback, because almost
// every account today is in India.
//
// Import-free so deno can test it alone.

const EXACT: Record<string, string> = {
  "Asia/Kolkata": "india", "Asia/Calcutta": "india",
  "Asia/Karachi": "pakistan", "Asia/Dhaka": "bangladesh", "Asia/Kathmandu": "nepal",
  "Asia/Katmandu": "nepal", "Asia/Colombo": "sri lanka", "Asia/Thimphu": "bhutan",
  "Indian/Maldives": "maldives",
  "Asia/Dubai": "united arab emirates", "Asia/Riyadh": "saudi arabia", "Asia/Qatar": "qatar",
  "Asia/Kuwait": "kuwait", "Asia/Bahrain": "bahrain", "Asia/Muscat": "oman",
  "Asia/Singapore": "singapore", "Asia/Kuala_Lumpur": "malaysia", "Asia/Jakarta": "indonesia",
  "Asia/Bangkok": "thailand", "Asia/Manila": "philippines", "Asia/Ho_Chi_Minh": "vietnam",
  "Asia/Tokyo": "japan", "Asia/Seoul": "south korea", "Asia/Shanghai": "china", "Asia/Taipei": "taiwan",
  "Europe/London": "united kingdom", "Europe/Dublin": "ireland", "Europe/Paris": "france",
  "Europe/Berlin": "germany", "Europe/Madrid": "spain", "Europe/Rome": "italy",
  "Europe/Amsterdam": "netherlands", "Europe/Brussels": "belgium", "Europe/Zurich": "switzerland",
  "Europe/Vienna": "austria", "Europe/Stockholm": "sweden", "Europe/Oslo": "norway",
  "Europe/Copenhagen": "denmark", "Europe/Helsinki": "finland", "Europe/Warsaw": "poland",
  "Europe/Lisbon": "portugal", "Europe/Athens": "greece", "Europe/Istanbul": "turkey",
  "Europe/Moscow": "russia",
  "Africa/Johannesburg": "south africa", "Africa/Lagos": "nigeria", "Africa/Nairobi": "kenya",
  "Africa/Cairo": "egypt",
  "Pacific/Auckland": "new zealand", "Pacific/Honolulu": "united states",
  "America/Sao_Paulo": "brazil", "America/Bogota": "colombia", "America/Lima": "peru",
  "America/Santiago": "chile",
};

const US = new Set([
  "America/New_York", "America/Chicago", "America/Denver", "America/Los_Angeles", "America/Phoenix",
  "America/Anchorage", "America/Detroit", "America/Boise", "America/Juneau", "America/Adak",
]);
const CANADA = new Set([
  "America/Toronto", "America/Vancouver", "America/Edmonton", "America/Winnipeg", "America/Halifax",
  "America/St_Johns", "America/Regina", "America/Montreal",
]);
const MEXICO = new Set(["America/Mexico_City", "America/Monterrey", "America/Tijuana", "America/Cancun"]);

export function countryForTimezone(tz: string | null | undefined, fallback: string | null): string | null {
  const zone = (tz ?? "").trim();
  if (!zone) return fallback;
  // Own properties only: a zone string like "constructor" must not read Object.prototype.
  if (Object.hasOwn(EXACT, zone)) return EXACT[zone];
  if (US.has(zone) || zone.startsWith("America/Indiana/") || zone.startsWith("America/Kentucky/") ||
    zone.startsWith("America/North_Dakota/") || zone.startsWith("US/")) return "united states";
  if (CANADA.has(zone) || zone.startsWith("Canada/")) return "canada";
  if (MEXICO.has(zone)) return "mexico";
  if (zone.startsWith("America/Argentina/")) return "argentina";
  if (zone.startsWith("Australia/")) return "australia";
  return null;
}
