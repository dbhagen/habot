import { debug } from "./debug";

/**
 * Derive the WebSocket URL for Ingress.
 *
 * HA Ingress serves the add-on at a dynamic path like:
 *   /api/hassio_ingress/<token>/
 *
 * We derive the WS URL from the current page location so it works
 * regardless of the Ingress token.
 */
export function getWebSocketUrl(): string {
  const { protocol, host, pathname } = window.location;
  const wsProtocol = protocol === "https:" ? "wss:" : "ws:";

  // Strip trailing slashes and any file names from the path
  // Ingress path is everything up to the add-on's root
  let basePath = pathname.replace(/\/+$/, "");

  // If path ends with index.html or similar, strip the filename
  if (basePath.includes(".")) {
    basePath = basePath.substring(0, basePath.lastIndexOf("/"));
  }

  const url = `${wsProtocol}//${host}${basePath}/ws`;
  debug("ingress", `WebSocket URL constructed`, { protocol, host, pathname, basePath, url });
  return url;
}

/**
 * Get the base URL for API requests.
 */
export function getApiBaseUrl(): string {
  let basePath = window.location.pathname.replace(/\/+$/, "");
  if (basePath.includes(".")) {
    basePath = basePath.substring(0, basePath.lastIndexOf("/"));
  }
  debug("ingress", `API base URL resolved`, { basePath });
  return basePath;
}
