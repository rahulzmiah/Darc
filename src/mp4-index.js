// Reads the sample table of an MP4's first video track, so the editor can
// decode a recording frame by frame (WebCodecs has no demuxer). Only the moov
// box is read; sample data stays on disk and is fetched by offset.
const fs = require('fs');

function readAt(fd, position, length) {
  const buf = Buffer.alloc(length);
  const n = fs.readSync(fd, buf, 0, length, position);
  return buf.subarray(0, n);
}

// Child boxes of buf[start, end): { type, start (of payload), end }.
function boxes(buf, start = 0, end = buf.length) {
  const out = [];
  let p = start;
  while (p + 8 <= end) {
    let size = buf.readUInt32BE(p);
    const type = buf.toString('latin1', p + 4, p + 8);
    let header = 8;
    if (size === 1) {
      size = Number(buf.readBigUInt64BE(p + 8));
      header = 16;
    } else if (size === 0) size = end - p;
    if (size < header || p + size > end) break;
    out.push({ type, start: p + header, end: p + size });
    p += size;
  }
  return out;
}

const child = (buf, box, type) => boxes(buf, box.start, box.end).find((b) => b.type === type);
const path = (buf, box, ...types) => types.reduce((b, t) => b && child(buf, b, t), box);

// Finds the top-level moov without reading the (huge) mdat.
function readMoov(fd, fileSize) {
  let p = 0;
  while (p + 8 <= fileSize) {
    const head = readAt(fd, p, 16);
    let size = head.readUInt32BE(0);
    const type = head.toString('latin1', 4, 8);
    if (size === 1) size = Number(head.readBigUInt64BE(8));
    else if (size === 0) size = fileSize - p;
    if (size < 8) break;
    if (type === 'moov') return readAt(fd, p, size);
    p += size;
  }
  throw new Error('Not a finished MP4 (no moov box)');
}

function readMp4Index(file) {
  const fd = fs.openSync(file, 'r');
  try {
    const buf = readMoov(fd, fs.fstatSync(fd).size);
    const moov = { start: 8, end: buf.length };
    const track = boxes(buf, moov.start, moov.end)
      .filter((b) => b.type === 'trak')
      .find((t) => {
        const hdlr = path(buf, t, 'mdia', 'hdlr');
        return hdlr && buf.toString('latin1', hdlr.start + 8, hdlr.start + 12) === 'vide';
      });
    if (!track) throw new Error('No video track');
    const mdhd = path(buf, track, 'mdia', 'mdhd');
    const v1 = buf[mdhd.start] === 1;
    const timescale = buf.readUInt32BE(mdhd.start + (v1 ? 20 : 12));
    const stbl = path(buf, track, 'mdia', 'minf', 'stbl');
    const table = (type) => child(buf, stbl, type);

    // Codec and its configuration record (the decoder's `description`).
    const stsd = table('stsd');
    const entry = boxes(buf, stsd.start + 8, stsd.end)[0];
    const width = buf.readUInt16BE(entry.start + 24);
    const height = buf.readUInt16BE(entry.start + 26);
    const config = boxes(buf, entry.start + 78, entry.end).find((b) => b.type === 'avcC' || b.type === 'hvcC');
    if (!config) throw new Error(`Unsupported codec ${entry.type}`);
    const description = Buffer.from(buf.subarray(config.start, config.end));

    // Sample sizes.
    const stsz = table('stsz');
    const fixed = buf.readUInt32BE(stsz.start + 4);
    const count = buf.readUInt32BE(stsz.start + 8);
    const sizes = new Array(count);
    for (let i = 0; i < count; i++) sizes[i] = fixed || buf.readUInt32BE(stsz.start + 12 + i * 4);

    // Chunk offsets, then samples per chunk, give each sample's offset.
    const co = table('stco') || table('co64');
    const chunks = buf.readUInt32BE(co.start + 4);
    const chunkOffset = (i) => (co.type === 'co64' ? Number(buf.readBigUInt64BE(co.start + 8 + i * 8)) : buf.readUInt32BE(co.start + 8 + i * 4));
    const stsc = table('stsc');
    const runs = [];
    for (let i = 0, n = buf.readUInt32BE(stsc.start + 4); i < n; i++) {
      const at = stsc.start + 8 + i * 12;
      runs.push({ first: buf.readUInt32BE(at) - 1, perChunk: buf.readUInt32BE(at + 4) });
    }
    const offsets = new Array(count);
    let s = 0;
    for (let c = 0; c < chunks && s < count; c++) {
      let run = runs[0];
      for (const r of runs) if (r.first <= c) run = r;
      let off = chunkOffset(c);
      for (let k = 0; k < run.perChunk && s < count; k++, s++) {
        offsets[s] = off;
        off += sizes[s];
      }
    }

    // Decode times, plus composition offsets if frames were reordered.
    const dts = new Array(count);
    const stts = table('stts');
    let t = 0;
    s = 0;
    for (let i = 0, n = buf.readUInt32BE(stts.start + 4); i < n; i++) {
      const sc = buf.readUInt32BE(stts.start + 8 + i * 8);
      const delta = buf.readUInt32BE(stts.start + 12 + i * 8);
      for (let k = 0; k < sc && s < count; k++, s++) {
        dts[s] = t;
        t += delta;
      }
    }
    const cto = new Array(count).fill(0);
    const ctts = table('ctts');
    if (ctts) {
      s = 0;
      for (let i = 0, n = buf.readUInt32BE(ctts.start + 4); i < n; i++) {
        const sc = buf.readUInt32BE(ctts.start + 8 + i * 8);
        const off = buf.readInt32BE(ctts.start + 12 + i * 8);
        for (let k = 0; k < sc && s < count; k++, s++) cto[s] = off;
      }
    }

    // Keyframes; with no stss every sample is one.
    const stss = table('stss');
    const keys = new Set();
    if (stss) for (let i = 0, n = buf.readUInt32BE(stss.start + 4); i < n; i++) keys.add(buf.readUInt32BE(stss.start + 8 + i * 4) - 1);

    const samples = new Array(count);
    for (let i = 0; i < count; i++) {
      samples[i] = {
        offset: offsets[i],
        size: sizes[i],
        dts: dts[i] / timescale,
        pts: (dts[i] + cto[i]) / timescale,
        key: stss ? keys.has(i) : true,
      };
    }
    return { codec: entry.type, width, height, description, samples, duration: t / timescale };
  } finally {
    fs.closeSync(fd);
  }
}

module.exports = { readMp4Index };
