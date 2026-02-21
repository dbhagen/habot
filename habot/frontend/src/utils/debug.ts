import { getApiBaseUrl } from "./ingress";

let debugEnabled = false;
let initialized = false;

export async function initDebugLogging(): Promise<void> {
  if (initialized) return;
  initialized = true;

  try {
    const resp = await fetch(`${getApiBaseUrl()}/api/config`);
    if (resp.ok) {
      const config = (await resp.json()) as { debugLogging: boolean };
      debugEnabled = config.debugLogging;
      if (debugEnabled) {
        console.debug("[DEBUG] Frontend debug logging enabled");
      }
    }
  } catch {
    // Server not reachable yet — debug stays off
  }
}

export function debug(context: string, message: string, data?: unknown): void {
  if (!debugEnabled) return;
  const ts = new Date().toISOString();
  if (data !== undefined) {
    const serialized =
      typeof data === "string"
        ? data
        : JSON.stringify(data, null, 2);
    console.debug(`[DEBUG][${ts}][${context}] ${message}\n${serialized}`);
  } else {
    console.debug(`[DEBUG][${ts}][${context}] ${message}`);
  }
}
