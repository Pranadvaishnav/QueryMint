export type DiscoveryStatus = "loading" | "success" | "error";
export type DiscoveryView = "loading" | "error" | "empty" | "results";

/** Keeps loading and failed requests distinct from a successful empty response. */
export function discoveryView(status: DiscoveryStatus, resultCount: number): DiscoveryView {
  if (resultCount > 0) return "results";
  if (status === "loading") return "loading";
  if (status === "error") return "error";
  return "empty";
}
