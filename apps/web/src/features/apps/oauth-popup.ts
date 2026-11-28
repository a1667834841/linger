import { desktopConnectorOAuth } from "./desktop-connector-oauth";

const OAUTH_POPUP_NAME = "linger_composio_oauth";
const OAUTH_POPUP_WIDTH = 560;
const OAUTH_POPUP_HEIGHT = 720;

export function openOAuthPopup(
  connectUrl: string,
  name = OAUTH_POPUP_NAME,
): Window | null {
  const left = Math.max(
    0,
    Math.round(window.screenX + (window.outerWidth - OAUTH_POPUP_WIDTH) / 2),
  );
  const top = Math.max(
    0,
    Math.round(window.screenY + (window.outerHeight - OAUTH_POPUP_HEIGHT) / 2),
  );
  return window.open(
    connectUrl,
    name,
    [
      "popup=yes",
      `width=${OAUTH_POPUP_WIDTH}`,
      `height=${OAUTH_POPUP_HEIGHT}`,
      `left=${left}`,
      `top=${top}`,
      "resizable=yes",
      "scrollbars=yes",
    ].join(","),
  );
}

export function openCustomMCPOAuthUrl(connectUrl: string): boolean {
  const url = safeOAuthURL(connectUrl);
  if (!url) return false;
  if (desktopConnectorOAuth()) return openOAuthUrl(url.href);
  // The authorization server is user-selected. Remove the opener before navigating.
  const popup = openOAuthPopup("about:blank", "_blank");
  if (!popup) return false;
  popup.opener = null;
  popup.location.replace(url.href);
  return true;
}

export function openOAuthUrl(connectUrl: string): boolean {
  const popup = openOAuthPopup(connectUrl);
  // Electron sends the URL to the browser and denies the in-app popup.
  if (popup) return true;
  if (!desktopConnectorOAuth()) return false;
  return Boolean(safeOAuthURL(connectUrl));
}

function safeOAuthURL(value: string): URL | undefined {
  try {
    const target = new URL(value);
    if (
      (target.protocol === "http:" || target.protocol === "https:") &&
      !target.username &&
      !target.password
    ) {
      return target;
    }
  } catch {
    return undefined;
  }
}
