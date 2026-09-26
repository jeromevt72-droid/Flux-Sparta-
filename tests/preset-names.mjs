// Test helper: the preset pilot-name rules, read from the REAL worker.js (so tests and server can't drift).
// P('TITAN') turns a test label into a fixed, valid preset name (e.g. "BRAVE OTTER 37").
import fs from 'fs'; import path from 'path'; import { fileURLToPath } from 'url';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const src = fs.readFileSync(path.join(__dirname, 'FLUX-Sparta', 'worker.js'), 'utf8');
const block = src.slice(src.indexOf('const NAME_ADJ = '), src.indexOf('function presetOrOwn('));
const mod = new Function(block + '; return { NAME_ADJ, NAME_NOUN, NAME_NUMS, isPresetName, presetNameFrom, presetNameForId };')();
export const { NAME_ADJ, NAME_NOUN, NAME_NUMS, isPresetName, presetNameFrom, presetNameForId } = mod;
export const P = (label) => presetNameForId('label:' + label);
