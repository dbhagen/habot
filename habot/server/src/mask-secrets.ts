/**
 * Token/secret detection and masking utility.
 *
 * Pure utility — no project imports to avoid circular dependencies.
 * Applied at server exit points (DB writes, WebSocket sends) so that
 * secrets never reach storage or the browser, while the agent still
 * receives unmasked content for its work.
 */

// ---------------------------------------------------------------------------
// Masking format
// ---------------------------------------------------------------------------

function formatMasked(token: string): string {
  if (token.length > 12) {
    return `${token.slice(0, 4)}...${token.slice(-3)} (${token.length} chars)`;
  }
  if (token.length > 4) {
    return `${token.slice(0, 2)}...${token.slice(-2)} (${token.length} chars)`;
  }
  return `****`;
}

// Anti-double-masking: check if a match is already masked
const ALREADY_MASKED_SUFFIX = /\s\(\d+ chars\)$/;

function isAlreadyMasked(text: string, matchEnd: number): boolean {
  // Look ahead for " (NN chars)" pattern right after the match
  const ahead = text.slice(matchEnd, matchEnd + 20);
  return ALREADY_MASKED_SUFFIX.test(ahead);
}

// ---------------------------------------------------------------------------
// Token patterns (applied in priority order)
// ---------------------------------------------------------------------------

interface TokenPattern {
  regex: RegExp;
  /** Given a match, return [startInMatch, secretPart] to mask */
  extract: (match: RegExpExecArray) => { prefix: string; secret: string } | null;
}

const TOKEN_PATTERNS: TokenPattern[] = [
  // 1. URL credentials  ://user:password@
  {
    regex: /:\/\/([^:@\s]+):([^@\s]+)@/g,
    extract: (m) => ({ prefix: `://${m[1]}:`, secret: m[2] }),
  },

  // 2. Bearer tokens
  {
    regex: /\bBearer\s+([A-Za-z0-9_\-./+=]{20,})/g,
    extract: (m) => ({ prefix: "Bearer ", secret: m[1] }),
  },

  // 3. Known-prefix API keys
  {
    regex:
      /\b(sk-ant-api\d{2}-[A-Za-z0-9_\-]{10,}|sk-[A-Za-z0-9_\-]{20,}|ghp_[A-Za-z0-9]{20,}|gho_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|xoxb-[A-Za-z0-9\-]{20,}|xoxp-[A-Za-z0-9\-]{20,}|glpat-[A-Za-z0-9_\-]{20,}|pypi-[A-Za-z0-9_\-]{20,}|npm_[A-Za-z0-9]{20,})/g,
    extract: (m) => ({ prefix: "", secret: m[1] }),
  },

  // 4. JWT tokens (three base64url segments separated by dots)
  {
    regex: /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_\-.]{10,}/g,
    extract: (m) => ({ prefix: "", secret: m[0] }),
  },

  // 5. Env var assignments (KEY=value)
  {
    regex:
      /\b([A-Z_]*(?:API_KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|AUTH)(?:_[A-Z_]*)?)\s*=\s*(['"]?)(\S{8,})\2/gi,
    extract: (m) => ({ prefix: `${m[1]}=`, secret: m[3] }),
  },

  // 6. Long hex strings (≥40 chars, standalone)
  {
    regex: /\b([0-9a-fA-F]{40,})\b/g,
    extract: (m) => ({ prefix: "", secret: m[1] }),
  },

  // 7. Long base64-like strings (≥40 chars)
  {
    regex: /\b([A-Za-z0-9+/=_\-]{40,})\b/g,
    extract: (m) => {
      // Avoid false positives: must have a mix (not all lowercase alpha, etc.)
      const s = m[1];
      const hasDigit = /\d/.test(s);
      const hasUpper = /[A-Z]/.test(s);
      const hasSpecial = /[+/=_\-]/.test(s);
      if ((hasDigit && hasUpper) || hasSpecial) {
        return { prefix: "", secret: s };
      }
      return null;
    },
  },
];

// ---------------------------------------------------------------------------
// Range tracking to prevent overlapping replacements
// ---------------------------------------------------------------------------

interface MaskedRange {
  start: number;
  end: number;
}

function overlaps(ranges: MaskedRange[], start: number, end: number): boolean {
  return ranges.some((r) => start < r.end && end > r.start);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Find and mask token/secret patterns in a string.
 * Returns the string with secrets replaced by a masked format.
 */
export function maskSecrets(text: string): string {
  if (!text || typeof text !== "string") return text;

  const maskedRanges: MaskedRange[] = [];
  // Collect all replacements, then apply from end to start to preserve indices
  const replacements: { start: number; end: number; replacement: string }[] = [];

  for (const pattern of TOKEN_PATTERNS) {
    // Reset regex state for each pattern
    const regex = new RegExp(pattern.regex.source, pattern.regex.flags);
    let match: RegExpExecArray | null;

    while ((match = regex.exec(text)) !== null) {
      const fullMatchStart = match.index;
      const fullMatchEnd = fullMatchStart + match[0].length;

      // Skip if overlapping with already-processed range
      if (overlaps(maskedRanges, fullMatchStart, fullMatchEnd)) continue;

      // Skip if already masked
      if (isAlreadyMasked(text, fullMatchEnd)) continue;

      const extracted = pattern.extract(match);
      if (!extracted) continue;

      const { prefix, secret } = extracted;
      const masked = formatMasked(secret);

      // Find where the secret starts within the full match
      const secretStartInText = text.indexOf(secret, fullMatchStart);
      const secretEnd = secretStartInText + secret.length;

      replacements.push({
        start: secretStartInText,
        end: secretEnd,
        replacement: masked,
      });
      maskedRanges.push({ start: fullMatchStart, end: fullMatchEnd });
    }
  }

  // Sort replacements from end to start so indices stay valid
  replacements.sort((a, b) => b.start - a.start);

  let result = text;
  for (const { start, end, replacement } of replacements) {
    result = result.slice(0, start) + replacement + result.slice(end);
  }

  return result;
}

/**
 * Deep-clone an object, applying maskSecrets to every string leaf.
 * Handles arrays, plain objects, and primitives. Non-string leaves
 * are returned as-is.
 */
export function maskSecretsInObject(obj: unknown): unknown {
  if (obj === null || obj === undefined) return obj;

  if (typeof obj === "string") return maskSecrets(obj);

  if (Array.isArray(obj)) return obj.map(maskSecretsInObject);

  if (typeof obj === "object") {
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(obj as Record<string, unknown>)) {
      result[key] = maskSecretsInObject(value);
    }
    return result;
  }

  // number, boolean, etc.
  return obj;
}
