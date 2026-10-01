// A small .gitignore matcher for folders that are NOT git repos.
// (Inside git repos we ask git itself via `git ls-files --exclude-standard`.)
// Supports comments, negation, trailing-slash dir rules, anchoring, *, ?, **.

export interface IgnoreRule {
  re: RegExp;
  negate: boolean;
  dirOnly: boolean;
}

function globToRegex(glob: string): string {
  let out = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') {
        const slashAfter = glob[i + 2] === '/';
        out += slashAfter ? '(?:.*/)?' : '.*';
        i += slashAfter ? 2 : 1;
      } else {
        out += '[^/]*';
      }
    } else if (c === '?') {
      out += '[^/]';
    } else if (c === '\\' && i + 1 < glob.length) {
      out += '\\' + glob[++i];
    } else {
      out += /[.+^${}()|[\]\\]/.test(c) ? '\\' + c : c;
    }
  }
  return out;
}

export function parseGitignore(text: string): IgnoreRule[] {
  const rules: IgnoreRule[] = [];
  for (const raw of text.split(/\r?\n/)) {
    let line = raw.replace(/(?<!\\)\s+$/, '');
    if (!line || line.startsWith('#')) continue;
    let negate = false;
    if (line.startsWith('!')) { negate = true; line = line.slice(1); }
    let dirOnly = false;
    if (line.endsWith('/')) { dirOnly = true; line = line.slice(0, -1); }
    const anchored = line.includes('/');
    if (line.startsWith('/')) line = line.slice(1);
    if (!line) continue;
    const body = globToRegex(line);
    // Unanchored patterns match a name at any depth; a matched dir also covers its contents.
    const re = new RegExp((anchored ? '^' : '^(?:.*/)?') + body + '(?:/.*)?$');
    rules.push({ re, negate, dirOnly });
  }
  return rules;
}

/** `rel` is relative to the .gitignore's directory, using `/` separators. Last match wins. */
export function isIgnored(rules: IgnoreRule[], rel: string, isDir: boolean): boolean {
  let ignored = false;
  for (const r of rules) {
    if (r.dirOnly && !isDir && !hasDirMatch(r, rel)) continue;
    if (r.re.test(rel)) ignored = !r.negate;
  }
  return ignored;
}

// A dir-only rule like `build/` still ignores files *inside* a matching dir.
function hasDirMatch(r: IgnoreRule, rel: string): boolean {
  const parts = rel.split('/');
  for (let i = 1; i < parts.length; i++) {
    if (r.re.test(parts.slice(0, i).join('/'))) return true;
  }
  return false;
}
