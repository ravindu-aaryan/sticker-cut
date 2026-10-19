// Copies the ESRGAN upscaling model weights (shipped inside the npm package)
// into public/ so the app can load them from its own origin, offline.
import { cpSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const src = join(root, 'node_modules/@upscalerjs/esrgan-slim/models');
const dest = join(root, 'public/models/esrgan-slim');

if (!existsSync(src)) {
  console.warn('[models] @upscalerjs/esrgan-slim not installed; AI upscaling will be unavailable.');
  process.exit(0);
}
mkdirSync(dest, { recursive: true });
for (const scale of ['x2', 'x4']) {
  cpSync(join(src, scale), join(dest, scale), { recursive: true });
}
console.log('[models] ESRGAN weights copied to public/models/esrgan-slim');
