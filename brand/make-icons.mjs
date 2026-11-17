// Turns the generated logo image into clean brand assets.
// Usage (from a folder where `sharp` resolves):
//   node make.mjs <source image> <output dir>
import { createRequire } from 'node:module';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const require = createRequire(join(process.cwd(), 'package.json'));
const sharp = require('sharp');
const [src, out] = process.argv.slice(2);
mkdirSync(out, { recursive: true });

// 1. Alpha mask of the gold letter: background is at most ~65 luminance,
//    the gold at least ~140. Ramp between them for smooth edges.
const BOX = { left: 700, top: 245, width: 576, height: 594 };
const { data, info } = await sharp(src).extract(BOX).removeAlpha().raw().toBuffer({ resolveWithObject: true });
const mask = Buffer.alloc(info.width * info.height);
for (let i = 0; i < mask.length; i++) {
	const L = 0.299 * data[i * 3] + 0.587 * data[i * 3 + 1] + 0.114 * data[i * 3 + 2];
	mask[i] = Math.max(0, Math.min(255, Math.round(((L - 78) / (140 - 78)) * 255)));
}
const maskPng = await sharp(mask, { raw: { width: info.width, height: info.height, channels: 1 } }).png().toBuffer();
// Trim to the letter itself.
const trimmed = await sharp(maskPng).trim({ threshold: 10 }).toBuffer({ resolveWithObject: true });
const MW = trimmed.info.width, MH = trimmed.info.height;
console.log('letter', MW, MH);

// 2. The letter filled with a colour (flat or a vertical gradient).
async function letter(height, top, bottom = top) {
	const width = Math.round((MW / MH) * height);
	const fill = Buffer.from(
		`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${top}"/><stop offset="1" stop-color="${bottom}"/></linearGradient></defs><rect width="100%" height="100%" fill="url(#g)"/></svg>`,
	);
	const alpha = await sharp(trimmed.data).resize(width, height).extractChannel(0).raw().toBuffer();
	const rgb = await sharp(fill).removeAlpha().raw().toBuffer();
	const rgba = Buffer.alloc(width * height * 4);
	for (let i = 0; i < width * height; i++) {
		rgba[i * 4] = rgb[i * 3];
		rgba[i * 4 + 1] = rgb[i * 3 + 1];
		rgba[i * 4 + 2] = rgb[i * 3 + 2];
		rgba[i * 4 + 3] = alpha[i];
	}
	return sharp(rgba, { raw: { width, height, channels: 4 } }).png().toBuffer();
}

const GOLD = ['#F1D49A', '#C8954A'];
const INK = '#2B2118';
const WALNUT = '#6B4226';

// Transparent marks for the website and documents.
await sharp(await letter(1024, ...GOLD)).toFile(join(out, 'mark-gold.png'));
await sharp(await letter(1024, WALNUT)).toFile(join(out, 'mark-walnut.png'));
await sharp(await letter(1024, '#F4ECDD')).toFile(join(out, 'mark-parchment.png'));

// 3. App icon: gold letter on a dark walnut rounded square.
async function icon(size) {
	const r = Math.round(size * 0.225);
	const bg = Buffer.from(
		`<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}"><defs><radialGradient id="b" cx="0.5" cy="0.42" r="0.75"><stop offset="0" stop-color="#4A3829"/><stop offset="1" stop-color="${INK}"/></radialGradient></defs><rect width="${size}" height="${size}" rx="${r}" fill="url(#b)"/></svg>`,
	);
	// Small icons get a bigger letter: there is no room to spare.
	const h = Math.round(size * (size <= 32 ? 0.84 : 0.72));
	const l = await letter(h, ...GOLD);
	const lw = (await sharp(l).metadata()).width;
	return sharp(bg)
		.composite([{ input: l, left: Math.round((size - lw) / 2), top: Math.round((size - h) / 2) }])
		.png({ compressionLevel: 9 })
		.toBuffer();
}

writeFileSync(join(out, 'icon-1024.png'), await icon(1024));
writeFileSync(join(out, 'icon.png'), await icon(512));
writeFileSync(join(out, '128x128.png'), await icon(128));
writeFileSync(join(out, '32x32.png'), await icon(32));

// 4. Windows .ico with PNG entries (Vista and later read them).
const sizes = [16, 24, 32, 48, 64, 128, 256];
const pngs = await Promise.all(sizes.map(icon));
const header = Buffer.alloc(6 + 16 * sizes.length);
header.writeUInt16LE(0, 0);
header.writeUInt16LE(1, 2);
header.writeUInt16LE(sizes.length, 4);
let offset = header.length;
sizes.forEach((s, i) => {
	const e = 6 + 16 * i;
	header.writeUInt8(s >= 256 ? 0 : s, e);
	header.writeUInt8(s >= 256 ? 0 : s, e + 1);
	header.writeUInt16LE(1, e + 4); // colour planes
	header.writeUInt16LE(32, e + 6); // bits per pixel
	header.writeUInt32LE(pngs[i].length, e + 8);
	header.writeUInt32LE(offset, e + 12);
	offset += pngs[i].length;
});
writeFileSync(join(out, 'icon.ico'), Buffer.concat([header, ...pngs]));

// Preview sheet of the small sizes, enlarged without smoothing.
const preview = await Promise.all(
	[16, 24, 32, 48].map(async (s) => sharp(await icon(s)).resize(s * 4, s * 4, { kernel: 'nearest' }).toBuffer()),
);
let x = 16;
const comps = preview.map((input, i) => {
	const c = { input, left: x, top: 16 };
	x += [16, 24, 32, 48][i] * 4 + 24;
	return c;
});
await sharp({ create: { width: x, height: 48 * 4 + 32, channels: 4, background: '#F4ECDD' } })
	.composite(comps)
	.png()
	.toFile(join(out, 'preview-small.png'));
console.log('done');
