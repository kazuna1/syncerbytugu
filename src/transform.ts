/**
 * Path rewriting between "this PC's project path" and portable tokens.
 *
 * Tokens are wrapped in U+0001. A raw control character can never appear in a
 * valid JSONL transcript (JSON escapes it as \u0001), so a conversation that
 * happens to mention the token text can't be corrupted on restore.
 */
export const TOKEN_ESC = '\u0001ROOT_ESC\u0001'; // root as written inside JSON: C:\\dev\\app
export const TOKEN_FWD = '\u0001ROOT_FWD\u0001'; // root with forward slashes:   C:/dev/app

const isWin = process.platform === 'win32';

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * The root as written inside JSON (escaped backslashes) and with forward
 * slashes. A Windows root can reach us in either slash style (Claude sometimes
 * records cwd as C:/Users/x), so both forms are derived from the backslash one.
 */
function rootForms(root: string): { esc: string; fwd: string } {
  let r = root.replace(/[\\/]+$/, '');
  if (/^[a-zA-Z]:[\\/]/.test(r) || r.startsWith('\\\\')) r = r.replace(/\//g, '\\');
  return { esc: r.replace(/\\/g, '\\\\'), fwd: r.replace(/\\/g, '/') };
}

/** Replace this PC's project root with tokens. Only matches at a path boundary. */
export function tokenize(content: string, root: string, caseInsensitive = isWin): string {
  const { esc, fwd } = rootForms(root);
  if (!fwd) return content;
  // boundary: followed by a backslash, slash, closing quote, or end of string
  const boundary = '(?=\\\\|/|"|$)';
  const flags = caseInsensitive ? 'gi' : 'g';
  let out = content;
  if (esc !== fwd) out = out.replace(new RegExp(escapeRegex(esc) + boundary, flags), TOKEN_ESC);
  out = out.replace(new RegExp(escapeRegex(fwd) + boundary, flags), TOKEN_FWD);
  return out;
}

/** Replace tokens with this PC's project root (plain string replace, no regex). */
export function detokenize(content: string, root: string): string {
  const { esc, fwd } = rootForms(root);
  return content.split(TOKEN_ESC).join(esc).split(TOKEN_FWD).join(fwd);
}
