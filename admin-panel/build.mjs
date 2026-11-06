// Builds the admin panel into dist/.
// Set ADMIN_API_BASE_URL (for example https://api.example.com) to point the panel at your backend.
// If it is not set, the sign-in screen asks for the server address instead.
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';

const raw = (process.env.ADMIN_API_BASE_URL || '').trim().replace(/\/+$/, '').replace(/\/api$/, '');
let apiOrigin = '';
if (raw) {
  const url = new URL(raw); // throws on a bad value, failing the build early
  if (url.protocol !== 'https:' && !['localhost', '127.0.0.1'].includes(url.hostname)) {
    throw new Error('ADMIN_API_BASE_URL must use https://');
  }
  apiOrigin = url.origin;
}

rmSync('dist', { recursive: true, force: true });
mkdirSync('dist');
cpSync('src', 'dist', { recursive: true });

writeFileSync(
  'dist/config.js',
  `window.SAMAPATRA_ADMIN_CONFIG = Object.freeze(${JSON.stringify({ apiBaseUrl: raw })});\n`
);

// With a fixed backend, the page may only talk to that backend.
const connectSrc = apiOrigin ? `'self' ${apiOrigin}` : `'self' https: http://localhost:* http://127.0.0.1:*`;
const csp = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data:",
  `connect-src ${connectSrc}`,
  "base-uri 'none'",
  "form-action 'none'",
].join('; ');
const html = readFileSync('dist/index.html', 'utf8').replace(
  '<!--CSP-->',
  `<meta http-equiv="Content-Security-Policy" content="${csp}">`
);
writeFileSync('dist/index.html', html);

console.log(`Built admin panel${raw ? ` for ${raw}` : ' (server address entered at sign-in)'}`);
