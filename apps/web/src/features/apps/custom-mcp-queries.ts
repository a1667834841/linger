import type { TeamHubExternalSourceClient } from "@/features/teamhub/teamhub-external-source-client";

export const customMCPQueryKey = ["teamhub", "custom-mcp-connections"] as const;

export function customMCPQueryOptions(client: TeamHubExternalSourceClient) {
  return {
    queryKey: customMCPQueryKey,
    queryFn: () => client.listCustomMCP(),
  };
}
