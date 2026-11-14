// Deterministic OKLCH palettes, converted to sRGB with chroma reduced only when out of gamut.
// Oklab matrices: https://bottosson.github.io/posts/oklab/ (2021-01-25 update).
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';

function srgb([lightness, chroma, hue]) {
  const angle = hue * Math.PI / 180;
  let rgb;
  do {
    const a = chroma * Math.cos(angle), b = chroma * Math.sin(angle);
    const l = (lightness + .3963377774 * a + .2158037573 * b) ** 3;
    const m = (lightness - .1055613458 * a - .0638541728 * b) ** 3;
    const s = (lightness - .0894841775 * a - 1.291485548 * b) ** 3;
    rgb = [4.0767416621 * l - 3.3077115913 * m + .2309699292 * s, -1.2684380046 * l + 2.6097574011 * m - .3413193965 * s, -.0041960863 * l - .7034186147 * m + 1.707614701 * s];
    chroma *= .98;
  } while (rgb.some(channel => channel < -.00001 || channel > 1.00001) && chroma > .0001);
  return '#' + rgb.map(channel => Math.round(255 * (channel <= .0031308 ? channel * 12.92 : 1.055 * channel ** (1 / 2.4) - .055))).map(channel => Math.min(255, Math.max(0, channel)).toString(16).padStart(2, '0')).join('');
}
function luminance(hex) {
  const rgb = hex.match(/[a-f\d]{2}/gi).map(channel => parseInt(channel, 16) / 255).map(channel => channel <= .04045 ? channel / 12.92 : ((channel + .055) / 1.055) ** 2.4);
  return .2126 * rgb[0] + .7152 * rgb[1] + .0722 * rgb[2];
}
function contrast(a, b) { const values = [luminance(a), luminance(b)].sort((a, b) => b - a); return (values[0] + .05) / (values[1] + .05); }
assert.equal(srgb([0, 0, 0]), '#000000');
assert.equal(srgb([1, 0, 0]), '#ffffff');
assert.equal(contrast('#000000', '#ffffff'), 21);

const palettes = {
  camp: { paper: [.95,.03,90], surface: [.98,.025,90], sidebar: [.91,.04,125], ink: [.30,.045,150], muted: [.43,.04,140], line: [.75,.045,125], accent: [.47,.15,30], 'accent-hover': [.39,.13,30], 'accent-pale': [.90,.065,75], green: [.40,.06,145], danger: [.44,.15,30], 'on-accent': [.98,.025,90] },
  night: { paper: [.22,.035,270], surface: [.27,.04,270], sidebar: [.19,.035,270], ink: [.94,.025,85], muted: [.79,.055,280], line: [.48,.055,275], accent: [.82,.12,85], 'accent-hover': [.90,.10,85], 'accent-pale': [.34,.06,280], green: [.82,.07,160], danger: [.80,.11,25], 'on-accent': [.22,.035,270] },
  handheld: { paper: [.86,.10,125], surface: [.92,.09,125], sidebar: [.78,.10,125], ink: [.24,.055,140], muted: [.36,.07,140], line: [.36,.07,140], accent: [.24,.055,140], 'accent-hover': [.36,.07,140], 'accent-pale': [.78,.10,125], green: [.36,.07,140], danger: [.24,.055,140], 'on-accent': [.92,.09,125] },
};
const blocks = [];
for (const [name, roles] of Object.entries(palettes)) {
  const colors = Object.fromEntries(Object.entries(roles).map(([role, color]) => [role, srgb(color)]));
  for (const foreground of ['ink', 'muted', 'green', 'danger']) {
    for (const background of ['paper', 'surface', 'sidebar', 'accent-pale']) {
      assert(contrast(colors[foreground], colors[background]) >= 4.5, `${name}: ${foreground}/${background} below 4.5`);
    }
  }
  assert(contrast(colors['on-accent'], colors.accent) >= 4.5, `${name}: action contrast below 4.5`);
  assert(contrast(colors['on-accent'], colors['accent-hover']) >= 4.5, `${name}: hover contrast below 4.5`);
  blocks.push(`${name === 'camp' ? ':root, ' : ''}:root[data-theme="${name}"] {\n  color-scheme: ${name === 'night' ? 'dark' : 'light'};\n${Object.entries(colors).map(([role, color]) => `  --${role}: ${color};`).join('\n')}\n}`);
  console.log(`${name}: muted/surface ${contrast(colors.muted, colors.surface).toFixed(2)}:1, action ${contrast(colors['on-accent'], colors.accent).toFixed(2)}:1`);
}
const file = new URL('../src/pixel-theme.css', import.meta.url);
const previous = readFileSync(file, 'utf8');
const start = '/* Generated palettes: node scripts/generate-themes.mjs */';
const end = '/* End generated palettes */';
const generated = `${start}\n${blocks.join('\n\n')}\n${end}`;
const updated = previous.includes(start) ? previous.replace(new RegExp(`${start.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[\\s\\S]*?${end.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`), generated) : `${generated}\n\n${previous}`;
if (process.argv.includes('--check')) assert.equal(previous, updated, 'Run node scripts/generate-themes.mjs to update palette tokens');
else writeFileSync(file, updated);
