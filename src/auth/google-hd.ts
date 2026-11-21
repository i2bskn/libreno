// OIDC_REQUIRE_GOOGLE_HD: whether the first OIDC login (linking an invited user or creating the first admin) needs
// the Google Workspace domain claim (hd) for accounts other than Gmail. hd is specific to Google, so it is off by
// default and meant only for IdPs that are Google or Cloudflare Access with Google as the only login method.

// "off" when unset, empty or "false"; "on" for "true"; "invalid" for anything else, including non-strings (a JSON
// variable in the dashboard) and values with other cases or surrounding spaces.
export function googleHdSetting(value: unknown): "off" | "on" | "invalid" {
  if (value === undefined) return "off";
  if (typeof value !== "string") return "invalid";
  if (value === "" || value === "false") return "off";
  if (value === "true") return "on";
  return "invalid";
}

// Gmail accounts (@gmail.com only) have no hd. Other Google accounts must carry a non-empty hd. The value is not
// matched against a list of domains: Workspace accounts of partners are accepted too.
export function satisfiesGoogleHd(email: string, claims: Readonly<Record<string, unknown>>): boolean {
  if (email.endsWith("@gmail.com")) return true;
  return typeof claims.hd === "string" && claims.hd.trim() !== "";
}
