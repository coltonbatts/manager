// Tiny terminal formatting helpers. Quiet by design: dim and bold, no colors.

const tty = process.stdout.isTTY && !process.env.NO_COLOR;
export const dim = (s: string) => (tty ? `\x1b[2m${s}\x1b[22m` : s);
export const bold = (s: string) => (tty ? `\x1b[1m${s}\x1b[22m` : s);

export function ago(ms: number | null, now = Date.now()): string {
  if (!ms) return '—';
  const s = Math.max(0, (now - ms) / 1000);
  if (s < 3600) return `${Math.max(1, Math.round(s / 60))}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  const d = Math.round(s / 86400);
  if (d < 60) return `${d}d ago`;
  if (d < 730) return `${Math.round(d / 30)}mo ago`;
  return `${Math.round(d / 365)}y ago`;
}

export function bytes(n: number): string {
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  while (n >= 1024 && i < units.length - 1) { n /= 1024; i++; }
  return `${n < 10 && i > 0 ? n.toFixed(1) : Math.round(n)} ${units[i]}`;
}

/** Pads or truncates a plain (unstyled) string to a fixed width. */
export function pad(s: string, width: number): string {
  return s.length > width ? s.slice(0, width - 1) + '…' : s.padEnd(width);
}

export function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}
