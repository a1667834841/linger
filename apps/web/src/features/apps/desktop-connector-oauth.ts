import type { CustomMCPOAuthResponse } from "@/features/teamhub/teamhub-external-source-client";

interface DesktopConnectorOAuth {
  prepare(): Promise<string>;
  prepareCustomMCP?(endpoint: string): Promise<string>;
  onReturn(
    callback: (
      connectedAccountId?: string,
      customMCP?: CustomMCPOAuthResponse,
    ) => void,
  ): () => void;
}

export function desktopConnectorOAuth() {
  return typeof window === "undefined"
    ? undefined
    : (window as { lingerDesktop?: { connectorOAuth?: DesktopConnectorOAuth } })
        .lingerDesktop?.connectorOAuth;
}
