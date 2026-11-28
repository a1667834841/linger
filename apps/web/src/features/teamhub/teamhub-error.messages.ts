import { defineMessages } from "@/i18n/messages";

/**
 * What a failed TeamHub request tells the person when TeamHub's code or the
 * response status says all there is to say. Other codes keep TeamHub's own
 * message.
 */
export const teamHubErrorMessages = defineMessages("teamHubErrors", {
  unauthenticated: "Your sign-in has expired. Sign in again.",
  rateLimited: "Too many requests. Wait a moment and try again.",
  unavailable: "The server is temporarily unavailable. Try again shortly.",
  internal: "Something went wrong on the server. Try again.",
  computerOffline: "The computer is offline.",
  refused: "The server refused this request. Reload the page and try again.",
  notCompleted:
    "The server could not complete this request ({status}). Try again.",
  unreachable:
    "Couldn't reach the server. Check your connection and try again.",
  customMcpOAuthRequired: "The MCP server requires OAuth authorization.",
  customMcpReauthorizationRequired: "Authorize the MCP connector again.",
  customMcpOAuthMetadataInvalid:
    "The MCP server did not provide a supported OAuth configuration.",
  customMcpOAuthResponseInvalid:
    "The authorization server did not complete authorization.",
  customMcpOAuthStateInvalid:
    "The authorization attempt is invalid or has expired.",
  customMcpOAuthRegistrationRequired:
    "Enter credentials for a registered OAuth client.",
  customMcpOAuthBindingChanged:
    "The authorization server changed. Refresh the connector and authorize again.",
});
