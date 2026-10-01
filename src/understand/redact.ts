// Last line of defense before text reaches the LLM: scrub anything that looks
// like a credential, even inside READMEs or commit messages.

const PATTERNS: RegExp[] = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  /\bsk-[A-Za-z0-9_-]{16,}/g, // OpenAI / Anthropic style
  /\b(?:sk|pk|rk)_(?:live|test)_[A-Za-z0-9]{10,}/g, // Stripe
  /\bgh[pousr]_[A-Za-z0-9]{20,}/g, // GitHub
  /\bgithub_pat_[A-Za-z0-9_]{20,}/g,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/g, // Slack
  /\bAKIA[0-9A-Z]{16}\b/g, // AWS
  /\bAIza[0-9A-Za-z_-]{35}\b/g, // Google
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g, // JWT
  /\b[a-z][a-z0-9+.-]*:\/\/[^\s:/@]+:[^\s@/]+@/gi, // credentials in URLs
];

// key = value / key: value where the key names a secret
const ASSIGNMENT = /\b([A-Za-z0-9_]*(?:api[_-]?key|secret|token|password|passwd|pwd|private[_-]?key|access[_-]?key|auth)[A-Za-z0-9_]*)(\s*[:=]\s*)(["']?)([^\s"']{6,})\3/gi;

export function redact(text: string): string {
  let out = text;
  for (const re of PATTERNS) out = out.replace(re, '[REDACTED]');
  return out.replace(ASSIGNMENT, (_m, key: string, sep: string, q: string) => `${key}${sep}${q}[REDACTED]${q}`);
}
