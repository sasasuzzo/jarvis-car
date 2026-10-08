import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, extname } from 'node:path';

const ROOT = new URL('..', import.meta.url).pathname;
const SKIP = new Set(['node_modules', '.git', 'vendor', 'tests']);
function* walk(d) {
  for (const n of readdirSync(d)) {
    if (SKIP.has(n)) continue;
    const p = join(d, n);
    if (statSync(p).isDirectory()) yield* walk(p); else yield p;
  }
}
test('nessuna chiave o credenziale nel repository', () => {
  const patterns = [/gsk_[A-Za-z0-9]{20,}/, /AIza[0-9A-Za-z_-]{30,}/, /einsteinpadredellafisica/i, /salvocacioppo/i, /sk-[A-Za-z0-9]{30,}/];
  for (const f of walk(ROOT)) {
    if (['.png', '.ico'].includes(extname(f))) continue;
    const s = readFileSync(f, 'utf8');
    for (const re of patterns) assert.ok(!re.test(s), `${f} contiene ${re}`);
  }
});
