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

function trimRoot(root: string): string {
  return root.replace(/[\\/]+$/, '');
}

/** Replace this PC's project root with tokens. Only matches at a path boundary. */
export function tokenize(content: string, root: string, caseInsensitive = isWin): string {
  const r = trimRoot(root);
  if (!r) return content;
  const esc = r.replace(/\\/g, '\\\\');
  const fwd = r.replace(/\\/g, '/');
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
  const r = trimRoot(root);
  const esc = r.replace(/\\/g, '\\\\');
  const fwd = r.replace(/\\/g, '/');
  return content.split(TOKEN_ESC).join(esc).split(TOKEN_FWD).join(fwd);
}
