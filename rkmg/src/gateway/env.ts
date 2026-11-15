import fs from 'node:fs';

/**
 * Parse .env text into key/value pairs. Pure and side-effect free so it can be
 * unit-tested. Rules: `KEY=VALUE` per line; blank lines and `#` comments are
 * ignored; only the first `=` splits (values may contain `=`); surrounding
 * single/double quotes are stripped; keys and values are trimmed.
 */
export function parseDotEnv(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    if (!key) continue;
    let val = line.slice(eq + 1).trim();
    if (val.length >= 2 && ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'")))) {
      val = val.slice(1, -1);
    }
    out[key] = val;
  }
  return out;
}

/**
 * Load a .env file into process.env WITHOUT overwriting variables already set in
 * the real environment (the real environment always wins). Returns true if the
 * file existed and was read. Never throws.
 */
export function loadDotEnv(envPath: string): boolean {
  try {
    if (!fs.existsSync(envPath)) return false;
    const parsed = parseDotEnv(fs.readFileSync(envPath, 'utf-8'));
    for (const [key, val] of Object.entries(parsed)) {
      if (process.env[key] === undefined) process.env[key] = val;
    }
    return true;
  } catch {
    return false;
  }
}
