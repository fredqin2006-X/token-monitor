/**
 * Distinguishes local CLI / NPX / embedded-app usage (loopback) from a public deployment hostname.
 * Used for default route (dashboard vs landing) and Home link targets.
 */
/** True when the dashboard is served from loopback or an explicitly allowed local tunnel host. */
export function isLocalDashboardHost(): boolean {
  if (typeof window === "undefined") return false;
  const h = window.location.hostname;
  if (h === "localhost" || h === "127.0.0.1" || h === "::1" || h === "[::1]") return true;
  const localHosts = (window as { __TOKENTRACKER_RUNTIME_CONFIG__?: { localHosts?: string[] } })
    .__TOKENTRACKER_RUNTIME_CONFIG__?.localHosts;
  return Array.isArray(localHosts) && localHosts.includes(h);
}

/** Path to open the dashboard from marketing: loopback keeps `/` as dashboard; public deploy uses `/dashboard` while `/` stays landing. */
export function getDashboardEntryPath(): string {
  return isLocalDashboardHost() ? "/" : "/dashboard";
}
