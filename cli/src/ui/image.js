'use strict';

/**
 * Inline image viewing.
 *
 * PNG is decoded here (zlib), JPEG with jpeg-js. Pixels are drawn with
 * half-block characters (two pixels per cell, truecolor or 256-color), which
 * works in every terminal. iTerm2, WezTerm and compatible terminals get the
 * real image through the OSC 1337 protocol instead.
 */

const zlib = require('node:zlib');
const ansi = require('../tui/ansi');

const MAX_PIXELS = 40 * 1000 * 1000;

function sniff(bytes) {
  if (bytes.length > 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return 'png';
  if (bytes.length > 3 && bytes[0] === 0xff && bytes[1] === 0xd8) return 'jpeg';
  if (bytes.length > 6 && bytes.slice(0, 3).toString('latin1') === 'GIF') return 'gif';
  if (bytes.length > 12 && bytes.slice(0, 4).toString('latin1') === 'RIFF' && bytes.slice(8, 12).toString('latin1') === 'WEBP') return 'webp';
  return null;
}

function paeth(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  return pb <= pc ? b : c;
}

function decodePng(bytes) {
  let pos = 8;
  let header = null;
  let palette = null;
  let transparency = null;
  const idat = [];
  while (pos + 8 <= bytes.length) {
    const length = bytes.readUInt32BE(pos);
    const type = bytes.toString('latin1', pos + 4, pos + 8);
    const data = bytes.subarray(pos + 8, pos + 8 + length);
    if (type === 'IHDR') {
      header = {
        width: data.readUInt32BE(0),
        height: data.readUInt32BE(4),
        depth: data[8],
        colorType: data[9],
        interlace: data[12],
      };
    } else if (type === 'PLTE') palette = data;
    else if (type === 'tRNS') transparency = data;
    else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') break;
    pos += 12 + length;
  }
  if (!header) throw new Error('not a PNG');
  if (header.interlace) throw new Error('interlaced PNG is not supported');
  const { width, height, depth, colorType } = header;
  if (width * height > MAX_PIXELS) throw new Error('image is too large to preview');
  const channels = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[colorType];
  if (!channels) throw new Error(`unsupported PNG color type ${colorType}`);
  const bitsPerPixel = channels * depth;
  const bpp = Math.max(1, bitsPerPixel >> 3);
  const stride = Math.ceil((width * bitsPerPixel) / 8);
  const raw = zlib.inflateSync(Buffer.concat(idat));
  if (raw.length < (stride + 1) * height) throw new Error('truncated PNG');

  const pixels = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y += 1) {
    const filter = raw[y * (stride + 1)];
    const src = y * (stride + 1) + 1;
    const dst = y * stride;
    for (let x = 0; x < stride; x += 1) {
      const left = x >= bpp ? pixels[dst + x - bpp] : 0;
      const up = y > 0 ? pixels[dst - stride + x] : 0;
      const upLeft = y > 0 && x >= bpp ? pixels[dst - stride + x - bpp] : 0;
      let value = raw[src + x];
      if (filter === 1) value += left;
      else if (filter === 2) value += up;
      else if (filter === 3) value += (left + up) >> 1;
      else if (filter === 4) value += paeth(left, up, upLeft);
      pixels[dst + x] = value & 0xff;
    }
  }

  const out = Buffer.alloc(width * height * 4);
  const maxValue = (1 << Math.min(depth, 8)) - 1;
  const sample = (row, index) => {
    if (depth === 8) return pixels[row + index];
    if (depth === 16) return pixels[row + index * 2];
    const bit = index * depth;
    const byte = pixels[row + (bit >> 3)];
    return (byte >> (8 - depth - (bit & 7))) & maxValue;
  };
  const scale = (v) => (depth < 8 ? Math.round((v * 255) / maxValue) : v);
  for (let y = 0; y < height; y += 1) {
    const row = y * stride;
    for (let x = 0; x < width; x += 1) {
      const o = (y * width + x) * 4;
      if (colorType === 0) {
        const g = scale(sample(row, x));
        out[o] = g; out[o + 1] = g; out[o + 2] = g; out[o + 3] = 255;
      } else if (colorType === 2) {
        out[o] = sample(row, x * 3); out[o + 1] = sample(row, x * 3 + 1); out[o + 2] = sample(row, x * 3 + 2); out[o + 3] = 255;
      } else if (colorType === 3) {
        const index = sample(row, x);
        out[o] = palette ? palette[index * 3] : 0;
        out[o + 1] = palette ? palette[index * 3 + 1] : 0;
        out[o + 2] = palette ? palette[index * 3 + 2] : 0;
        out[o + 3] = transparency && index < transparency.length ? transparency[index] : 255;
      } else if (colorType === 4) {
        const g = sample(row, x * 2);
        out[o] = g; out[o + 1] = g; out[o + 2] = g; out[o + 3] = sample(row, x * 2 + 1);
      } else {
        out[o] = sample(row, x * 4); out[o + 1] = sample(row, x * 4 + 1);
        out[o + 2] = sample(row, x * 4 + 2); out[o + 3] = sample(row, x * 4 + 3);
      }
    }
  }
  return { width, height, data: out };
}

function decodeImage(bytes) {
  const kind = sniff(bytes);
  if (kind === 'png') return decodePng(bytes);
  if (kind === 'jpeg') {
    const jpeg = require('jpeg-js');
    const decoded = jpeg.decode(bytes, { useTArray: true, maxMemoryUsageInMB: 256 });
    return { width: decoded.width, height: decoded.height, data: Buffer.from(decoded.data) };
  }
  throw new Error(kind ? `${kind.toUpperCase()} images cannot be previewed here` : 'unknown image format');
}

/** Area-average downscale (or nearest-neighbour upscale) to exactly tw x th. */
function resize({ width, height, data }, tw, th) {
  const out = Buffer.alloc(tw * th * 4);
  for (let y = 0; y < th; y += 1) {
    const y0 = (y * height) / th;
    const y1 = Math.max(y0 + 1e-6, ((y + 1) * height) / th);
    for (let x = 0; x < tw; x += 1) {
      const x0 = (x * width) / tw;
      const x1 = Math.max(x0 + 1e-6, ((x + 1) * width) / tw);
      let r = 0; let g = 0; let b = 0; let a = 0; let weightSum = 0;
      for (let sy = Math.floor(y0); sy < Math.min(height, Math.ceil(y1)); sy += 1) {
        const wy = Math.min(sy + 1, y1) - Math.max(sy, y0);
        for (let sx = Math.floor(x0); sx < Math.min(width, Math.ceil(x1)); sx += 1) {
          const w = wy * (Math.min(sx + 1, x1) - Math.max(sx, x0));
          const i = (sy * width + sx) * 4;
          const alpha = data[i + 3] / 255;
          r += data[i] * alpha * w; g += data[i + 1] * alpha * w; b += data[i + 2] * alpha * w;
          a += alpha * w;
          weightSum += w;
        }
      }
      const o = (y * tw + x) * 4;
      if (weightSum > 0 && a > 0) {
        out[o] = Math.round(r / a); out[o + 1] = Math.round(g / a); out[o + 2] = Math.round(b / a);
        out[o + 3] = Math.round((a / weightSum) * 255);
      }
    }
  }
  return out;
}

function sgrColor(prefix, r, g, b, truecolor) {
  return truecolor
    ? `\u001b[${prefix};2;${r};${g};${b}m`
    : `\u001b[${prefix};5;${ansi.rgbTo256(r, g, b)}m`;
}

/** Fits an image into a box of cells; a cell is one pixel wide and two tall. */
function fitSize(width, height, maxCols, maxRows) {
  const scale = Math.min(maxCols / width, (maxRows * 2) / height, 2);
  const tw = Math.max(1, Math.round(width * scale));
  let th = Math.max(2, Math.round(height * scale));
  if (th % 2) th += 1;
  return { tw, th };
}

/** Half-block rendering: returns one string per terminal row. */
function renderBlocks(bytes, { maxCols = 80, maxRows = 24, truecolor = ansi.detectTruecolor(), background = [24, 24, 24] } = {}) {
  const image = decodeImage(bytes);
  const { tw, th } = fitSize(image.width, image.height, maxCols, maxRows);
  const px = resize(image, tw, th);
  const lines = [];
  const blend = (i) => {
    const a = px[i + 3] / 255;
    return [0, 1, 2].map((k) => Math.round(px[i + k] * a + background[k] * (1 - a)));
  };
  for (let y = 0; y < th; y += 2) {
    let line = '';
    for (let x = 0; x < tw; x += 1) {
      const [tr, tg, tb] = blend((y * tw + x) * 4);
      const [br, bg, bb] = blend(((y + 1) * tw + x) * 4);
      line += `${sgrColor(38, tr, tg, tb, truecolor)}${sgrColor(48, br, bg, bb, truecolor)}▀`;
    }
    lines.push(`${line}\u001b[0m`);
  }
  return { lines, width: tw, height: th / 2, source: { width: image.width, height: image.height } };
}

function supportsInlineProtocol(env = process.env) {
  const forced = String(env.GCHAT_IMAGE_PROTOCOL || '').toLowerCase();
  if (forced === 'blocks') return false;
  if (forced === 'iterm') return true;
  const program = String(env.TERM_PROGRAM || '').toLowerCase();
  return program === 'iterm.app' || program === 'wezterm' || env.LC_TERMINAL === 'iTerm2';
}

/** OSC 1337 inline image (iTerm2, WezTerm): the terminal decodes and scales it. */
function renderInline(bytes, { maxCols = 80, name = 'image' } = {}) {
  const b64 = Buffer.from(bytes).toString('base64');
  const label = Buffer.from(name).toString('base64');
  return `\u001b]1337;File=name=${label};size=${bytes.length};inline=1;width=${maxCols};preserveAspectRatio=1:${b64}\u0007`;
}

module.exports = {
  sniff,
  decodeImage,
  decodePng,
  resize,
  fitSize,
  renderBlocks,
  renderInline,
  supportsInlineProtocol,
};
