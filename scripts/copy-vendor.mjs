#!/usr/bin/env node
// Copies Leaflet from node_modules into site/vendor so the site has no CDN dependency.
import { cp, mkdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const dest = join(root, 'site', 'vendor', 'leaflet');
await mkdir(dest, { recursive: true });
await cp(join(root, 'node_modules', 'leaflet', 'dist'), dest, { recursive: true });
console.log('• Copied Leaflet to site/vendor/leaflet');
