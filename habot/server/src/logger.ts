import { maskSecrets, maskSecretsInObject } from "./mask-secrets.js";

let debugEnabled = false;

export function setDebugLogging(enabled: boolean): void {
  debugEnabled = enabled;
  if (enabled) {
    console.log("[DEBUG] Debug logging enabled");
  }
}

export function debug(context: string, message: string, data?: unknown): void {
  if (!debugEnabled) return;
  const ts = new Date().toISOString();
  const maskedMessage = maskSecrets(message);
  if (data !== undefined) {
    const maskedData = maskSecretsInObject(data);
    const serialized =
      typeof maskedData === "string"
        ? maskedData
        : JSON.stringify(maskedData, null, 2);
    console.log(`[DEBUG][${ts}][${context}] ${maskedMessage}\n${serialized}`);
  } else {
    console.log(`[DEBUG][${ts}][${context}] ${maskedMessage}`);
  }
}
