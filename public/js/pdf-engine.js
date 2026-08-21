/* ═══════════════════════════════════════════════════════════════════════════
   PAPERJET — Compress · Merge · Split
   ═══════════════════════════════════════════════════════════════════════════

   Why this runs entirely in the browser, and never touches the server:

   1. The documents are BLs, invoices, packing lists and licences. Posting them
      to a server — ours or iLovePDF's — is a disclosure that nobody asked for
      and that we cannot take back. Here, the file is read by the tab the staff
      member already has open and never leaves the machine. "No need to store
      the PDFs" is not a policy we have to remember to honour; there is nowhere
      for them to be stored.
   2. Vercel's serverless request body cap would reject a 20 MB scan outright,
      and there is no Ghostscript binary in that runtime to compress it with.
   3. It works with the office internet down, and one person compressing a
      200-page scan cannot slow the portal down for anyone else.

   ── How compression actually works ────────────────────────────────────────
   Two passes, in this order, because the first is lossless where it matters:

   PASS A — recompress the embedded images, leave everything else alone.
     Text stays vector, fonts stay embedded, an OCR layer stays searchable and
     selectable. Only the raster images inside the file are downsampled and
     re-encoded as JPEG. This is what a compressor should do to a document
     that has real text in it, and it is where most scanned-in bulk lives.

   PASS B — rasterise whole pages (only when a target size demands it).
     Every page is rendered and re-embedded as a single JPEG. This always hits
     a smaller number, and it always costs the text layer. It is never used
     unless a size target could not be met by Pass A, and the UI says so out
     loud rather than quietly flattening someone's document.

   A page is never replaced by a bigger version of itself: every attempt is
   measured, and if compression made the file larger — which happens with
   files that are already optimised — the original is handed back untouched.
   ═════════════════════════════════════════════════════════════════════════ */
(function () {
'use strict';

// Captured here and not where it is used: document.currentScript is only the
// running <script> during top-level execution, and is null inside any function
// called later. A fault report needs to name the build it came from — the ?v=
// on this src is exactly that — so it is read once, now.
const BUILD = (document.currentScript && document.currentScript.src) || 'unknown';

// ─── Lazy library loading ──────────────────────────────────────────────────
// ~2 MB of pdf-lib + pdf.js. Nobody who never opens PDF Tools should pay for
// it, so neither library is fetched until the first file is actually dropped.
let _libP = null, _jsP = null;

function loadPdfLib() {
    if (_libP) return _libP;
    _libP = new Promise((resolve, reject) => {
        if (window.PDFLib) return resolve(window.PDFLib);
        const s = document.createElement('script');
        s.src = '/vendor/pdf-lib.min.js';
        s.onload = () => window.PDFLib ? resolve(window.PDFLib) : reject(new Error('pdf-lib failed to initialise'));
        s.onerror = () => reject(new Error('Could not load pdf-lib'));
        document.head.appendChild(s);
    });
    return _libP;
}

function loadPdfJs() {
    if (_jsP) return _jsP;
    _jsP = import('/vendor/pdf.min.mjs').then(mod => {
        mod.GlobalWorkerOptions.workerSrc = '/vendor/pdf.worker.min.mjs';
        return mod;
    });
    return _jsP;
}

// ─── Small helpers ─────────────────────────────────────────────────────────
const MB = 1048576;

function fmtSize(n) {
    if (n == null) return '—';
    if (n < 1024) return n + ' B';
    if (n < MB) return (n / 1024).toFixed(0) + ' KB';
    return (n / MB).toFixed(2) + ' MB';
}

function pct(from, to) {
    if (!from) return 0;
    return Math.max(0, Math.round((1 - to / from) * 100));
}

// "1-3, 7, 10-12" → [1,2,3,7,10,11,12], 1-based, de-duplicated, in order given.
// Returns null when the text cannot be read as a page list at all, and throws
// nothing — the caller decides how loudly to complain.
function parsePageSpec(spec, pageCount) {
    if (!spec || !spec.trim()) return null;
    const out = [];
    const seen = new Set();
    for (const part of spec.split(',')) {
        const t = part.trim();
        if (!t) continue;
        const m = t.match(/^(\d+)\s*(?:-\s*(\d+))?$/);
        if (!m) return null;
        let a = parseInt(m[1], 10);
        let b = m[2] ? parseInt(m[2], 10) : a;
        if (a < 1 || b < 1) return null;
        a = Math.min(a, pageCount); b = Math.min(b, pageCount);
        const step = a <= b ? 1 : -1;
        for (let p = a; step > 0 ? p <= b : p >= b; p += step) {
            if (!seen.has(p)) { seen.add(p); out.push(p); }
        }
    }
    return out.length ? out : null;
}

// ─── Store-only ZIP writer ─────────────────────────────────────────────────
// Split can produce twenty files, and twenty separate downloads is a browser
// fight nobody wins. PDFs are already deflated, so storing them uncompressed
// costs nothing and keeps this to a few dozen lines with no extra dependency.
const CRC_TABLE = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
        let c = n;
        for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
        t[n] = c >>> 0;
    }
    return t;
})();

function crc32(buf) {
    let c = 0xFFFFFFFF;
    for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
    return (c ^ 0xFFFFFFFF) >>> 0;
}

function makeZip(entries) {
    const enc = new TextEncoder();
    const chunks = [], central = [];
    let offset = 0;

    for (const e of entries) {
        const nameBytes = enc.encode(e.name);
        const data = e.data;
        const crc = crc32(data);

        const local = new DataView(new ArrayBuffer(30));
        local.setUint32(0, 0x04034b50, true);
        local.setUint16(4, 20, true);          // version needed
        local.setUint16(6, 0x0800, true);      // UTF-8 filename flag
        local.setUint16(8, 0, true);           // stored, no compression
        local.setUint16(10, 0, true);          // mod time
        local.setUint16(12, 0x21, true);       // mod date (fixed — no clock dependency)
        local.setUint32(14, crc, true);
        local.setUint32(18, data.length, true);
        local.setUint32(22, data.length, true);
        local.setUint16(26, nameBytes.length, true);
        local.setUint16(28, 0, true);
        chunks.push(new Uint8Array(local.buffer), nameBytes, data);

        const cen = new DataView(new ArrayBuffer(46));
        cen.setUint32(0, 0x02014b50, true);
        cen.setUint16(4, 20, true);
        cen.setUint16(6, 20, true);
        cen.setUint16(8, 0x0800, true);
        cen.setUint16(10, 0, true);
        cen.setUint16(12, 0, true);
        cen.setUint16(14, 0x21, true);
        cen.setUint32(16, crc, true);
        cen.setUint32(20, data.length, true);
        cen.setUint32(24, data.length, true);
        cen.setUint16(28, nameBytes.length, true);
        cen.setUint32(42, offset, true);
        central.push(new Uint8Array(cen.buffer), nameBytes);

        offset += 30 + nameBytes.length + data.length;
    }

    let centralSize = 0;
    for (const c of central) centralSize += c.length;

    const end = new DataView(new ArrayBuffer(22));
    end.setUint32(0, 0x06054b50, true);
    end.setUint16(8, entries.length, true);
    end.setUint16(10, entries.length, true);
    end.setUint32(12, centralSize, true);
    end.setUint32(16, offset, true);

    return new Blob([...chunks, ...central, new Uint8Array(end.buffer)], { type: 'application/zip' });
}

// ═══════════════════════════════════════════════════════════════════════════
// PASS A — recompress embedded images, keep text vector
// ═══════════════════════════════════════════════════════════════════════════

// Every one of these values may be stored as an INDIRECT REFERENCE rather than
// inline — "/DecodeParms 9 0 R" is as valid as "/DecodeParms << ... >>", and
// pdfkit writes it that way. Reading with a bare .get() hands back the PDFRef
// itself, so an `instanceof PDFDict` test fails, the predictor goes unnoticed,
// and the image is decoded as garbage. That is the same bug as the CONCOR one
// wearing a different hat, so nothing here reads a dictionary entry without
// resolving it first.
const deref = (L, ctx, v) => {
    try { return v instanceof L.PDFRef ? ctx.lookup(v) : v; }
    catch (e) { return null; }
};
const entry = (L, ctx, dict, key) => deref(L, ctx, dict.get(L.PDFName.of(key)));

const nameOf = (L, ctx, dict, key) => {
    const v = entry(L, ctx, dict, key);
    return v ? v.toString() : null;
};
const numOf = (L, ctx, dict, key) => {
    const v = entry(L, ctx, dict, key);
    if (!v) return null;
    const n = Number(v.toString());
    return isFinite(n) ? n : null;
};

// What colour space is this image in, in terms we can rebuild from a canvas?
// Anything we can't answer confidently returns null and the image is left
// exactly as it was — an untouched image is always better than a broken one.
function colourKind(L, ctx, dict) {
    const raw = entry(L, ctx, dict, 'ColorSpace');
    if (!raw) return null;
    const s = raw.toString();
    if (s === '/DeviceRGB') return 'rgb';
    if (s === '/DeviceGray') return 'gray';
    if (raw instanceof L.PDFArray && raw.size() >= 2 && raw.get(0).toString() === '/ICCBased') {
        try {
            const st = ctx.lookup(raw.get(1));
            const n = numOf(L, ctx, st.dict, 'N');
            if (n === 3) return 'rgb';
            if (n === 1) return 'gray';
        } catch (e) { /* fall through */ }
    }
    return null;   // Indexed, Separation, DeviceCMYK, Lab — not our business
}

// Collect every object referenced as a soft mask. Those carry the alpha
// channel and must stay single-component; re-encoding one as an RGB JPEG
// would turn transparency into garbage. They are skipped wholesale.
function collectSoftMaskRefs(L, ctx) {
    const refs = new Set();
    for (const [, obj] of ctx.enumerateIndirectObjects()) {
        const dict = obj instanceof L.PDFRawStream ? obj.dict : (obj instanceof L.PDFDict ? obj : null);
        if (!dict) continue;
        for (const key of ['SMask', 'Mask']) {
            const v = dict.get(L.PDFName.of(key));
            if (v instanceof L.PDFRef) refs.add(v.toString());
        }
    }
    return refs;
}

// Un-apply a PNG predictor (PDF /Predictor 10-15). The stream is stored as H
// rows, each one a filter-type byte followed by a row of samples that were
// encoded as deltas against the pixel to the left, the row above, or both.
// Reversing it is exactly the PNG spec's algorithm.
function undoPngPredictor(raw, columns, colors, bpc) {
    const bpp = Math.max(1, (colors * bpc) >> 3);          // bytes per pixel
    const rowLen = Math.ceil((columns * colors * bpc) / 8);
    const stride = rowLen + 1;                              // + the filter-type byte
    const rows = Math.floor(raw.length / stride);
    if (rows < 1) return null;

    const out = new Uint8Array(rows * rowLen);
    let prev = new Uint8Array(rowLen);

    for (let r = 0; r < rows; r++) {
        const ft = raw[r * stride];
        const cur = out.subarray(r * rowLen, (r + 1) * rowLen);
        cur.set(raw.subarray(r * stride + 1, r * stride + 1 + rowLen));

        switch (ft) {
            case 0: break;                                  // None
            case 1:                                         // Sub — left
                for (let i = bpp; i < rowLen; i++) cur[i] = (cur[i] + cur[i - bpp]) & 255;
                break;
            case 2:                                         // Up — above
                for (let i = 0; i < rowLen; i++) cur[i] = (cur[i] + prev[i]) & 255;
                break;
            case 3:                                         // Average
                for (let i = 0; i < rowLen; i++) {
                    const a = i >= bpp ? cur[i - bpp] : 0;
                    cur[i] = (cur[i] + ((a + prev[i]) >> 1)) & 255;
                }
                break;
            case 4:                                         // Paeth
                for (let i = 0; i < rowLen; i++) {
                    const a = i >= bpp ? cur[i - bpp] : 0;
                    const b = prev[i];
                    const c = i >= bpp ? prev[i - bpp] : 0;
                    const p = a + b - c;
                    const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
                    cur[i] = (cur[i] + (pa <= pb && pa <= pc ? a : (pb <= pc ? b : c))) & 255;
                }
                break;
            default:
                return null;                                // not a filter type we know
        }
        prev = cur;
    }
    return out;
}

async function decodeImage(L, ctx, stream) {
    const d = stream.dict;
    if (entry(L, ctx, d, 'ImageMask')) return null;          // 1-bit stencil
    const W = numOf(L, ctx, d, 'Width'), H = numOf(L, ctx, d, 'Height');
    if (!W || !H || W < 2 || H < 2) return null;

    // A colour-key mask is expressed as component ranges in the image's own
    // colour space. Re-encoding would leave those ranges describing something
    // that no longer exists, so these are left alone.
    const mask = entry(L, ctx, d, 'Mask');
    if (mask instanceof L.PDFArray) return null;

    const filter = nameOf(L, ctx, d, 'Filter');
    const bpc = numOf(L, ctx, d, 'BitsPerComponent');

    // Already a JPEG — the browser decodes it natively, whatever is inside.
    if (filter === '/DCTDecode') {
        try {
            const blob = new Blob([stream.contents.slice()], { type: 'image/jpeg' });
            return { bitmap: await createImageBitmap(blob), W, H };
        } catch (e) { return null; }
    }

    // A /Decode array remaps sample values — [1 0] inverts a channel. We rebuild
    // from pixels and drop the array, so honouring it would mean applying it
    // first. Rather than half-implement that, leave these alone.
    if (entry(L, ctx, d, 'Decode')) return null;

    // A raw deflated bitmap. Only the arrangements we can rebuild exactly.
    if (filter === '/FlateDecode' && bpc === 8) {
        const kind = colourKind(L, ctx, d);
        if (!kind) return null;
        let raw;
        try { raw = L.decodePDFRawStream(stream).decode(); } catch (e) { return null; }
        const comps = kind === 'rgb' ? 3 : 1;

        // decodePDFRawStream undoes the FILTER and nothing else — it inflates,
        // but never un-applies a predictor. Most Flate images in the wild carry
        // /Predictor 15, and reading that delta-encoded data as if it were
        // pixels produces an inverted, skewed mess. It shipped because the old
        // guard only rejected data that was too SHORT, and predicted data is
        // LONGER: one filter-type byte per row.
        let parms = entry(L, ctx, d, 'DecodeParms');
        // A filter CHAIN carries an array of parameter dicts, one per filter.
        if (parms instanceof L.PDFArray) {
            let picked = null;
            for (let i = 0; i < parms.size(); i++) {
                const cand = deref(L, ctx, parms.get(i));
                if (cand instanceof L.PDFDict) picked = cand;
            }
            parms = picked;
        }
        const predictor = parms instanceof L.PDFDict ? (numOf(L, ctx, parms, 'Predictor') || 1) : 1;
        if (predictor > 1) {
            if (predictor < 10) return null;   // TIFF predictor 2 — not handled
            const columns = numOf(L, ctx, parms, 'Columns') || 1;
            const colors  = numOf(L, ctx, parms, 'Colors') || 1;
            const pbpc    = numOf(L, ctx, parms, 'BitsPerComponent') || 8;
            // The predictor must describe the same image we think we have,
            // otherwise we are un-filtering to the wrong row length.
            if (columns !== W || colors !== comps || pbpc !== bpc) return null;
            raw = undoPngPredictor(raw, columns, colors, pbpc);
            if (!raw) return null;
        }

        // Exact, not "at least". Anything else means we have misread the layout,
        // and a misread bitmap is worse than an uncompressed one.
        if (raw.length < W * H * comps) return null;

        const img = new ImageData(W, H);
        const px = img.data;
        for (let i = 0, j = 0, k = 0; i < W * H; i++) {
            if (comps === 3) { px[j] = raw[k]; px[j + 1] = raw[k + 1]; px[j + 2] = raw[k + 2]; k += 3; }
            else { px[j] = px[j + 1] = px[j + 2] = raw[k]; k += 1; }
            px[j + 3] = 255;
            j += 4;
        }
        return { imageData: img, W, H };
    }

    // CCITTFax, JBIG2, JPX, and anything at 1 or 4 bits per component. These
    // are either already near-optimally packed (bilevel fax scans) or need a
    // decoder we do not have. Untouched.
    return null;
}

function renderTo(src, w, h) {
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    const g = c.getContext('2d', { alpha: false, willReadFrequently: true });
    g.fillStyle = '#FFFFFF';
    g.fillRect(0, 0, w, h);
    g.imageSmoothingEnabled = true;
    g.imageSmoothingQuality = 'high';
    if (src.bitmap) {
        g.drawImage(src.bitmap, 0, 0, w, h);
    } else {
        const t = document.createElement('canvas');
        t.width = src.W; t.height = src.H;
        t.getContext('2d').putImageData(src.imageData, 0, 0);
        g.drawImage(t, 0, 0, w, h);
    }
    return c;
}

async function encodeJpegFrom(canvas, quality) {
    const blob = await new Promise(res => canvas.toBlob(res, 'image/jpeg', quality));
    if (!blob) return null;
    return new Uint8Array(await blob.arrayBuffer());
}

// ── Bilevel encoding ───────────────────────────────────────────────────────
// JPEG is a photographic codec, and a scanned notice is not a photograph. Sharp
// black text on white is nothing but high-frequency edges, which is the case
// JPEG handles worst: it spends bytes describing them and still rings around
// every letter. A real CONCOR trade notice measured 1.34 MB in, 565 KB out as
// JPEG — while the same page, scanned properly to bilevel CCITT, was 89 KB.
//
// So for pages that are genuinely black-on-white, we also build a 1-bit
// DeviceGray candidate and keep whichever is smaller. It is typically several
// times smaller AND sharper, because thresholding is lossless for text in a way
// that JPEG never is.

// Is this page safe to reduce to two tones? Only if it has essentially no
// colour to lose and almost nothing in the midtones — a photograph or a colour
// stamp would be destroyed, so anything ambiguous is left to JPEG.
function analysePixels(canvas) {
    const w = canvas.width, h = canvas.height;
    const d = canvas.getContext('2d', { willReadFrequently: true })
                    .getImageData(0, 0, w, h).data;
    const hist = new Uint32Array(256);
    const total = w * h;
    const step = Math.max(1, Math.floor(total / 200000));   // sample ~200k pixels
    let colour = 0, n = 0;
    for (let i = 0; i < total; i += step) {
        const j = i * 4;
        const r = d[j], g = d[j + 1], b = d[j + 2];
        if (Math.max(r, g, b) - Math.min(r, g, b) > 40) colour++;
        hist[(0.299 * r + 0.587 * g + 0.114 * b) | 0]++;
        n++;
    }
    // Everything that is neither clearly ink nor clearly paper. The band runs
    // right up to 235 on purpose: a light-grey shaded table cell sits around
    // 225, and thresholding just under the paper tone would turn that cell —
    // and the text inside it — into a solid black block. Counting it here is
    // what makes such a page fail the gate below and fall back to JPEG.
    let mid = 0;
    for (let v = 48; v <= 235; v++) mid += hist[v];
    return { colourFrac: colour / n, midFrac: mid / n, hist, samples: n };
}

// Where to cut between ink and paper.
//
// Otsu's optimum is the wrong answer for a scanned document, and measurably so.
// On a real CONCOR trade notice it chose 141, which deleted 3.3% of the page:
// every hairline table rule and every antialiased letter edge sat between 141
// and the paper, so the rules came out DASHED. Otsu is balancing two clusters,
// but a document is not two clusters — it is a huge white paper peak with a
// long thin tail of ink, and the tail is the content.
//
// So find the paper instead. The dominant peak in the light half IS the paper
// tone, whatever it happens to be, and anything meaningfully darker than the
// paper is ink worth keeping. That adapts to an off-white or grey scan in a way
// a fixed number cannot, and it never cuts below Otsu — on a page that really
// is two-tone, Otsu is already right.
function documentThreshold(hist, total) {
    let peak = 255, peakCount = -1;
    for (let v = 128; v < 256; v++) {
        if (hist[v] > peakCount) { peakCount = hist[v]; peak = v; }
    }
    const belowPaper = Math.min(Math.round(peak * 0.86), 240);
    return Math.max(otsuThreshold(hist, total), belowPaper);
}

// Otsu's method: the threshold that best separates the histogram into two
// groups. A fixed 128 blots out anything scanned against a grey background.
function otsuThreshold(hist, total) {
    let sum = 0;
    for (let i = 0; i < 256; i++) sum += i * hist[i];
    let sumB = 0, wB = 0, best = -1, thr = 128;
    for (let t = 0; t < 256; t++) {
        wB += hist[t];
        if (!wB) continue;
        const wF = total - wB;
        if (!wF) break;
        sumB += t * hist[t];
        const mB = sumB / wB, mF = (sum - sumB) / wF;
        const between = wB * wF * (mB - mF) * (mB - mF);
        if (between > best) { best = between; thr = t; }
    }
    return thr;
}

async function deflate(bytes) {
    // CompressionStream('deflate') emits zlib-wrapped data, which is exactly
    // what PDF's FlateDecode expects. Safari 16.4+, Chrome 80+.
    if (typeof CompressionStream === 'undefined') return null;
    const stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream('deflate'));
    return new Uint8Array(await new Response(stream).arrayBuffer());
}

async function encodeBilevelFrom(canvas, threshold) {
    const w = canvas.width, h = canvas.height;
    const d = canvas.getContext('2d', { willReadFrequently: true })
                    .getImageData(0, 0, w, h).data;
    // Each row starts on a byte boundary, per the PDF image model. A set bit is
    // white, matching DeviceGray where 1 is maximum intensity.
    const rowBytes = (w + 7) >> 3;
    const bits = new Uint8Array(rowBytes * h);
    for (let y = 0; y < h; y++) {
        const ro = y * rowBytes;
        for (let x = 0; x < w; x++) {
            const j = (y * w + x) * 4;
            const lum = 0.299 * d[j] + 0.587 * d[j + 1] + 0.114 * d[j + 2];
            if (lum > threshold) bits[ro + (x >> 3)] |= (0x80 >> (x & 7));
        }
    }
    return deflate(bits);
}

// Build every encoding that suits this image and keep the smallest. JPEG is
// always a candidate; bilevel only when the page is genuinely black-on-white,
// and at a higher resolution than the JPEG would use, because one bit per pixel
// is cheap and text crispness is the whole point of keeping it sharp.
// ≈300 DPI on A4, the resolution documents are actually scanned at. Set lower
// (220 DPI) at first, and the table rules on a real trade notice came out
// DASHED: shrinking averages a hairline rule with the white either side of it,
// which lifts stretches of it above the threshold and simply deletes them.
// Text survived that because letters are thick enough; one-pixel rules are not.
// At native scan resolution the rule stays a rule. One bit per pixel is cheap
// enough that this still lands far below any JPEG of the same page.
const BILEVEL_MAXSIDE = 3500;

async function bestEncoding(src, opts) {
    const longest = Math.max(src.W, src.H);
    const fit = (cap) => {
        const scale = Math.min(1, cap / longest);
        return [Math.max(1, Math.round(src.W * scale)), Math.max(1, Math.round(src.H * scale))];
    };

    const [jw, jh] = fit(opts.maxSide);
    const jpegCanvas = renderTo(src, jw, jh);
    const jpg = await encodeJpegFrom(jpegCanvas, opts.quality);
    let best = jpg ? { bytes: jpg, w: jw, h: jh, kind: 'jpeg' } : null;

    // Decide on the full-size render, not the downsampled one: shrinking blurs
    // the edges and would make a clean bilevel page look like a greyscale one.
    const probe = analysePixels(jpegCanvas);
    const isDocument = probe.colourFrac < 0.02 && probe.midFrac < 0.10;
    if (isDocument) {
        const [bw, bh] = fit(Math.max(opts.maxSide, BILEVEL_MAXSIDE));
        const bCanvas = (bw === jw && bh === jh) ? jpegCanvas : renderTo(src, bw, bh);
        const thr = documentThreshold(probe.hist, probe.samples);
        const bits = await encodeBilevelFrom(bCanvas, thr);
        if (bits && (!best || bits.length < best.bytes.length)) {
            best = { bytes: bits, w: bw, h: bh, kind: 'bilevel' };
        }
    }
    return best;
}

/**
 * Recompress every image we can read, in place. Returns the saved bytes.
 * `maxSide` caps the longest edge — an A4 page at 150 DPI is ~1755 px, so
 * anything bigger than that is detail the printer will never show.
 */
async function compressImages(bytes, opts, onProgress) {
    const L = await loadPdfLib();
    const doc = await L.PDFDocument.load(bytes, { ignoreEncryption: true, updateMetadata: false });
    const ctx = doc.context;
    const softMasks = collectSoftMaskRefs(L, ctx);

    const targets = [];
    for (const [ref, obj] of ctx.enumerateIndirectObjects()) {
        if (!(obj instanceof L.PDFRawStream)) continue;
        if (nameOf(L, ctx, obj.dict, 'Subtype') !== '/Image') continue;
        if (softMasks.has(ref.toString())) continue;
        targets.push([ref, obj]);
    }

    let done = 0, replaced = 0, saved = 0, bilevel = 0;
    for (const [ref, stream] of targets) {
        try {
            const src = await decodeImage(L, ctx, stream);
            if (src) {
                const best = await bestEncoding(src, opts);
                // Only ever swap for something smaller. An already-optimised
                // image re-encoded at higher quality would grow the file, which
                // is the opposite of what was asked for.
                if (best && best.bytes.length < stream.contents.length) {
                    const d = stream.dict;
                    d.set(L.PDFName.of('Width'), L.PDFNumber.of(best.w));
                    d.set(L.PDFName.of('Height'), L.PDFNumber.of(best.h));
                    d.delete(L.PDFName.of('DecodeParms'));
                    d.delete(L.PDFName.of('Decode'));
                    if (best.kind === 'bilevel') {
                        d.set(L.PDFName.of('Filter'), L.PDFName.of('FlateDecode'));
                        d.set(L.PDFName.of('ColorSpace'), L.PDFName.of('DeviceGray'));
                        d.set(L.PDFName.of('BitsPerComponent'), L.PDFNumber.of(1));
                    } else {
                        d.set(L.PDFName.of('Filter'), L.PDFName.of('DCTDecode'));
                        d.set(L.PDFName.of('ColorSpace'), L.PDFName.of('DeviceRGB'));
                        d.set(L.PDFName.of('BitsPerComponent'), L.PDFNumber.of(8));
                    }
                    ctx.assign(ref, L.PDFRawStream.of(d, best.bytes));
                    saved += stream.contents.length - best.bytes.length;
                    replaced++;
                    if (best.kind === 'bilevel') bilevel++;
                }
                if (src.bitmap) src.bitmap.close();
            }
        } catch (e) {
            // One unreadable image must never cost the whole document. Leave
            // it exactly as it was and carry on.
            console.warn('[pdf-tools] image skipped:', e.message);
        }
        done++;
        if (onProgress) onProgress(done / Math.max(1, targets.length));
    }

    // Object streams pack the cross-reference and small objects far tighter
    // than the plain form most producers emit. This alone is often 10–20%.
    const out = await doc.save({ useObjectStreams: true, addDefaultPage: false });
    return { bytes: out, images: targets.length, replaced, saved, bilevel };
}

// ═══════════════════════════════════════════════════════════════════════════
// PASS B — rasterise pages (last resort, and only for a size target)
// ═══════════════════════════════════════════════════════════════════════════

async function rasterisePdf(bytes, opts, onProgress) {
    const [L, pdfjs] = await Promise.all([loadPdfLib(), loadPdfJs()]);
    // destroy() lives on the LOADING TASK, not on the document proxy it
    // resolves to. Calling it on the document throws, and the worker it should
    // have torn down is left running — which is how a compress of a long file
    // used to leave a worker per attempt behind it.
    const task = pdfjs.getDocument({ data: bytes.slice(), isEvalSupported: false });
    const src = await task.promise;
    const out = await L.PDFDocument.create();

    try {
        for (let i = 1; i <= src.numPages; i++) {
            const page = await src.getPage(i);
            // Scale 1 already accounts for /Rotate, so the page keeps its
            // orientation and its exact physical size in the rebuilt file.
            const base = page.getViewport({ scale: 1 });
            const scale = Math.min(opts.maxSide / Math.max(base.width, base.height), 4);
            const vp = page.getViewport({ scale: Math.max(scale, 0.05) });

            const c = document.createElement('canvas');
            c.width = Math.max(1, Math.ceil(vp.width));
            c.height = Math.max(1, Math.ceil(vp.height));
            const g = c.getContext('2d', { alpha: false });
            g.fillStyle = '#FFFFFF';
            g.fillRect(0, 0, c.width, c.height);
            await page.render({ canvasContext: g, viewport: vp, background: '#FFFFFF' }).promise;

            const blob = await new Promise(r => c.toBlob(r, 'image/jpeg', opts.quality));
            const jpg = await out.embedJpg(new Uint8Array(await blob.arrayBuffer()));
            const p = out.addPage([base.width, base.height]);
            p.drawImage(jpg, { x: 0, y: 0, width: base.width, height: base.height });

            page.cleanup();
            if (onProgress) onProgress(i / src.numPages);
        }
        return await out.save({ useObjectStreams: true });
    } finally {
        task.destroy();
    }
}

// ═══════════════════════════════════════════════════════════════════════════
// The compressor the UI actually calls
// ═══════════════════════════════════════════════════════════════════════════

// Longest edge in pixels. An A4 page is 11.7in tall, so 150 DPI ≈ 1755 px —
// the point past which a scan carries detail no screen and no customs officer
// will ever look at.
// There is deliberately no "compress to N megabytes" here. A target forces the
// tool to keep degrading a document until an arbitrary number is satisfied,
// which is backwards — the number is arbitrary, the document is not. Compress
// well, show the result, and let whoever is looking at the page decide whether
// they want to run it through again. Each level below is an absolute standard,
// so the same file at the same level always comes out the same way.
const PRESETS = {
    light: {
        label: 'Light', maxSide: 2340, quality: 0.86, raster: false,
        note: '≈200 DPI. Barely distinguishable from the original — worth it when the scan has fine print.'
    },
    balanced: {
        label: 'Recommended', maxSide: 1755, quality: 0.74, raster: false,
        note: '≈150 DPI. Prints and reads cleanly. Usually the largest saving you can make without being able to see it.'
    },
    strong: {
        label: 'Strong', maxSide: 1240, quality: 0.58, raster: false,
        note: '≈110 DPI. Softer on fine print, still perfectly legible on screen.'
    },
    maximum: {
        label: 'Maximum', maxSide: 1240, quality: 0.60, raster: true,
        note: 'Flattens every page to an image. Much smaller, but the text stops being selectable or searchable — a last resort, not a default.'
    }
};

/**
 * @param {Uint8Array} bytes   the original file
 * @param {object} opts        { preset }
 * @param {function} report    (fraction, label) → void
 */
async function compress(bytes, opts, report) {
    const original = bytes.length;
    const say = (f, label) => report && report(Math.max(0, Math.min(1, f)), label);
    const steps = [];
    const tried = [];

    const consider = (result, rasterised, label) => {
        steps.push({ label, size: result.length });
        tried.push({ bytes: result, rasterised });
    };

    const p = PRESETS[opts.preset] || PRESETS.balanced;

    // The lossless image pass runs at every level, Maximum included. Rendering
    // a page that is mostly text produces something several times heavier than
    // the text it replaced — measured at 3.7 MB from a 0.45 MB original — so
    // "flatten everything" is only the right answer when it actually wins.
    // Running both and keeping the smaller costs one extra pass and removes the
    // whole class of outcome where asking for more compression gives you less.
    say(0.04, 'Reading document');
    const imaged = await compressImages(bytes, p,
        f => say(0.04 + f * (p.raster ? 0.36 : 0.92), 'Recompressing images'));
    consider(imaged.bytes, false, 'Images · ' + p.label);

    if (p.raster) {
        say(0.42, 'Rendering pages');
        const r = await rasterisePdf(bytes, p, f => say(0.42 + f * 0.54, 'Rendering pages'));
        consider(r, true, 'Rendered · ' + Math.round(p.maxSide / 11.7) + ' DPI');
    }

    // Smallest wins; where two tie, the one that kept the text layer is the
    // better document.
    const best = tried.reduce((a2, b2) => {
        if (b2.bytes.length !== a2.bytes.length) return b2.bytes.length < a2.bytes.length ? b2 : a2;
        return a2.rasterised && !b2.rasterised ? b2 : a2;
    });

    say(1, 'Done');
    return finish(original, best, steps, opts, imaged);
}

function finish(original, best, steps, opts, detail) {
    // Compressing an already-tight file can make it bigger — which is exactly
    // what happens when the same file is run through a second time hoping for
    // more. The honest answer then is the file they already had, plus a message
    // saying so, rather than a fractionally worse copy dressed up as a saving.
    if (!best || best.bytes.length >= original) {
        return {
            bytes: null, original, size: original, saved: 0,
            rasterised: false, steps, unchanged: true, detail
        };
    }
    return {
        bytes: best.bytes, original, size: best.bytes.length,
        saved: original - best.bytes.length,
        rasterised: best.rasterised, steps, unchanged: false, detail
    };
}

// ═══════════════════════════════════════════════════════════════════════════
// MERGE — lossless throughout; pages are copied, never re-rendered
// ═══════════════════════════════════════════════════════════════════════════

async function merge(files, report) {
    const L = await loadPdfLib();
    const out = await L.PDFDocument.create();
    let pages = 0;

    for (let i = 0; i < files.length; i++) {
        report && report(i / files.length, `Adding ${files[i].name}`);
        const src = await L.PDFDocument.load(files[i].bytes, { ignoreEncryption: true, updateMetadata: false });
        const copied = await out.copyPages(src, src.getPageIndices());
        copied.forEach(p => { out.addPage(p); pages++; });
    }

    report && report(0.95, 'Writing');
    const bytes = await out.save({ useObjectStreams: true });
    return { bytes, pages };
}

// ═══════════════════════════════════════════════════════════════════════════
// SPLIT — extract, remove, or break into several files
// ═══════════════════════════════════════════════════════════════════════════

async function extractPages(bytes, pageNumbers) {
    const L = await loadPdfLib();
    const src = await L.PDFDocument.load(bytes, { ignoreEncryption: true, updateMetadata: false });
    const out = await L.PDFDocument.create();
    const copied = await out.copyPages(src, pageNumbers.map(n => n - 1));
    copied.forEach(p => out.addPage(p));
    return await out.save({ useObjectStreams: true });
}

/**
 * @param mode  'extract' | 'remove' | 'each' | 'every' | 'ranges'
 * Returns either { bytes, name } for one file, or { entries } for a zip.
 */
async function split(bytes, mode, cfg, report) {
    const L = await loadPdfLib();
    const probe = await L.PDFDocument.load(bytes, { ignoreEncryption: true, updateMetadata: false });
    const count = probe.getPageCount();
    const stem = (cfg.stem || 'document').replace(/\.pdf$/i, '');

    if (mode === 'extract' || mode === 'remove') {
        const picked = cfg.pages && cfg.pages.length ? cfg.pages : parsePageSpec(cfg.spec, count);
        if (!picked) throw new Error('Enter the pages to use, for example 1-3, 7, 10-12');
        const list = mode === 'extract'
            ? picked
            : Array.from({ length: count }, (_, i) => i + 1).filter(p => !picked.includes(p));
        if (!list.length) throw new Error(mode === 'remove'
            ? 'That would remove every page — nothing would be left'
            : 'No pages selected');
        report && report(0.5, 'Building');
        return { bytes: await extractPages(bytes, list), name: `${stem}_${mode === 'extract' ? 'pages' : 'trimmed'}.pdf`, pages: list.length };
    }

    // Everything below produces several files, so they go out as one zip.
    let groups = [];
    if (mode === 'each') {
        groups = Array.from({ length: count }, (_, i) => [i + 1]);
    } else if (mode === 'every') {
        const n = Math.max(1, parseInt(cfg.everyN, 10) || 1);
        for (let i = 1; i <= count; i += n) {
            groups.push(Array.from({ length: Math.min(n, count - i + 1) }, (_, k) => i + k));
        }
    } else if (mode === 'ranges') {
        for (const part of String(cfg.spec || '').split(',')) {
            const g = parsePageSpec(part, count);
            if (g) groups.push(g);
        }
        if (!groups.length) throw new Error('Enter the ranges to split into, for example 1-4, 5-9, 10-12');
    }

    const entries = [];
    for (let i = 0; i < groups.length; i++) {
        report && report(i / groups.length, `File ${i + 1} of ${groups.length}`);
        const g = groups[i];
        const label = g.length === 1 ? `p${g[0]}` : `p${g[0]}-${g[g.length - 1]}`;
        entries.push({ name: `${stem}_${label}.pdf`, data: await extractPages(bytes, g) });
    }
    return { entries, count: entries.length };
}

// ═══════════════════════════════════════════════════════════════════════════
// ROTATE — lossless; only the /Rotate entry moves
// ═══════════════════════════════════════════════════════════════════════════

async function rotatePages(bytes, cfg) {
    const L = await loadPdfLib();
    const doc = await L.PDFDocument.load(bytes, { ignoreEncryption: true, updateMetadata: false });
    const pages = doc.getPages();
    // An empty list means the whole document — the common case by far, and the
    // one you get by pressing the button without touching the grid.
    const only = cfg.pages && cfg.pages.length ? new Set(cfg.pages) : null;
    let touched = 0;
    pages.forEach((p, i) => {
        if (only && !only.has(i + 1)) return;
        // Added to whatever the page already had, so rotating a page that a
        // scanner already marked sideways lands where you expect. Normalised to
        // 0/90/180/270 because some viewers ignore anything else.
        const now = p.getRotation().angle || 0;
        p.setRotation(L.degrees(((now + cfg.angle) % 360 + 360) % 360));
        touched++;
    });
    if (!touched) throw new Error('No pages selected to rotate');
    return { bytes: await doc.save({ useObjectStreams: true }), pages: touched };
}

/**
 * Rebuild a document in a given page order, with per-page turns and removals.
 *
 * @param order  [{ p, r }, …] — p is the page number in the ORIGINAL file, r a
 *               turn in degrees to add to whatever that page already carried.
 *               The array IS the new document: its length is the page count,
 *               its order is the page order, and anything missing is dropped.
 *
 * Pages are copied, never re-rendered, so this is lossless exactly like merge
 * and split. A page may legitimately appear twice — duplicating one is a normal
 * thing to want in a bundle — so nothing here deduplicates.
 */
async function organisePages(bytes, order) {
    const L = await loadPdfLib();
    if (!order || !order.length) throw new Error('There are no pages left to save');

    const src = await L.PDFDocument.load(bytes, { ignoreEncryption: true, updateMetadata: false });
    const total = src.getPageCount();
    const bad = order.find(o => !(o.p >= 1 && o.p <= total));
    if (bad) throw new Error(`Page ${bad.p} is not in this file`);

    const out = await L.PDFDocument.create();
    // copyPages takes the whole list at once so a page used twice is embedded
    // once and referenced twice, rather than copied twice into the output.
    const copied = await out.copyPages(src, order.map(o => o.p - 1));
    copied.forEach((page, i) => {
        const add = ((order[i].r || 0) % 360 + 360) % 360;
        if (add) {
            const now = page.getRotation().angle || 0;
            page.setRotation(L.degrees(((now + add) % 360 + 360) % 360));
        }
        out.addPage(page);
    });
    return { bytes: await out.save({ useObjectStreams: true }), pages: order.length };
}

// ═══════════════════════════════════════════════════════════════════════════
// STAMPING — page numbers and watermarks
// ═══════════════════════════════════════════════════════════════════════════

// A stamp is positioned by what the reader SEES, but drawn in unrotated PDF
// space. For a page carrying /Rotate the two differ, and scanned BLs very often
// carry one. These map a point in display space (origin at the visible
// bottom-left) to page space, and give the text rotation that cancels the
// page's own — so "bottom centre" is the bottom centre of the page as shown,
// not of the page as stored.
function displayBox(w, h, rot) {
    return (rot === 90 || rot === 270) ? { w: h, h: w } : { w, h };
}
function toPageSpace(vx, vy, w, h, rot) {
    switch (((rot % 360) + 360) % 360) {
        case 90:  return { x: w - vy, y: vx };
        case 180: return { x: w - vx, y: h - vy };
        case 270: return { x: vy, y: h - vx };
        default:  return { x: vx, y: vy };
    }
}

const NUM_POS = {
    'bottom-centre': { ax: 0.5, bottom: true },
    'bottom-right':  { ax: 1,   bottom: true },
    'bottom-left':   { ax: 0,   bottom: true },
    'top-centre':    { ax: 0.5, bottom: false },
    'top-right':     { ax: 1,   bottom: false },
    'top-left':      { ax: 0,   bottom: false }
};

async function numberPages(bytes, cfg, report) {
    const L = await loadPdfLib();
    const doc = await L.PDFDocument.load(bytes, { ignoreEncryption: true, updateMetadata: false });
    const font = await doc.embedFont(L.StandardFonts.Helvetica);
    const pages = doc.getPages();
    const total = pages.length;
    const pos = NUM_POS[cfg.position] || NUM_POS['bottom-centre'];
    const size = Math.max(6, Math.min(48, cfg.size || 11));
    const margin = 28;
    const from = Math.max(1, Math.min(total, cfg.from || 1));
    const start = cfg.start || 1;

    let stamped = 0;
    pages.forEach((p, i) => {
        const n = i + 1;
        if (n < from) return;
        const shown = start + (n - from);
        const label = (cfg.format || '{n}')
            .replace(/\{n\}/g, String(shown))
            .replace(/\{total\}/g, String(total - from + 1));

        const { width: w, height: h } = p.getSize();
        const rot = p.getRotation().angle || 0;
        const box = displayBox(w, h, rot);
        const tw = font.widthOfTextAtSize(label, size);

        // Inset from the edge, then pulled back by the text's own width so a
        // right-aligned number does not run off the page.
        const vx = pos.ax === 0.5 ? (box.w - tw) / 2
                 : pos.ax === 1   ? box.w - margin - tw
                 : margin;
        const vy = pos.bottom ? margin : box.h - margin - size;
        const pt = toPageSpace(vx, vy, w, h, rot);

        p.drawText(label, {
            x: pt.x, y: pt.y, size, font,
            color: L.rgb(0.13, 0.13, 0.17),
            rotate: L.degrees(rot)
        });
        stamped++;
    });
    if (!stamped) throw new Error('No pages to number');
    report && report(0.9, 'Saving');
    return { bytes: await doc.save({ useObjectStreams: true }), pages: stamped };
}

async function watermarkPdf(bytes, cfg, report) {
    const text = String(cfg.text || '').trim();
    if (!text) throw new Error('Type the watermark text first');

    const L = await loadPdfLib();
    const doc = await L.PDFDocument.load(bytes, { ignoreEncryption: true, updateMetadata: false });
    const font = await doc.embedFont(L.StandardFonts.HelveticaBold);
    const pages = doc.getPages();
    const opacity = Math.max(0.02, Math.min(1, (cfg.opacity == null ? 12 : cfg.opacity) / 100));
    const deg = cfg.angle == null ? 45 : cfg.angle;
    const rad = deg * Math.PI / 180;

    pages.forEach(p => {
        const { width: w, height: h } = p.getSize();
        const rot = p.getRotation().angle || 0;
        const box = displayBox(w, h, rot);

        // Sized to the page rather than to a fixed point value, so it reads the
        // same on an A5 delivery order and an A3 drawing.
        const size = cfg.size ? cfg.size
            : Math.max(14, Math.min(120, (Math.min(box.w, box.h) * 0.78) / Math.max(4, text.length) * 2.1));
        const tw = font.widthOfTextAtSize(text, size);

        // Centre the string on the page centre along its own baseline, in
        // display space, then hand the mapped point to the page.
        const vx = box.w / 2 - Math.cos(rad) * tw / 2 + Math.sin(rad) * size * 0.35;
        const vy = box.h / 2 - Math.sin(rad) * tw / 2 - Math.cos(rad) * size * 0.35;
        const pt = toPageSpace(vx, vy, w, h, rot);

        p.drawText(text, {
            x: pt.x, y: pt.y, size, font, opacity,
            color: L.rgb(0.85, 0.20, 0.18),
            // The page's own rotation plus the angle asked for, so a diagonal
            // stamp stays diagonal to the reader on a sideways page.
            rotate: L.degrees(rot + deg)
        });
    });
    report && report(0.9, 'Saving');
    return { bytes: await doc.save({ useObjectStreams: true }), pages: pages.length };
}

// ═══════════════════════════════════════════════════════════════════════════
// PDF → JPG — one image per page, delivered as a zip
// ═══════════════════════════════════════════════════════════════════════════

async function pagesToImages(bytes, cfg, report) {
    const pdfjs = await loadPdfJs();
    const task = pdfjs.getDocument({ data: bytes.slice(), isEvalSupported: false });
    const stem = (cfg.stem || 'document').replace(/\.pdf$/i, '');
    const only = cfg.pages && cfg.pages.length ? new Set(cfg.pages) : null;
    const entries = [];

    try {
        const doc = await task.promise;
        const wanted = [];
        for (let i = 1; i <= doc.numPages; i++) if (!only || only.has(i)) wanted.push(i);
        if (!wanted.length) throw new Error('No pages selected');
        const pad = String(doc.numPages).length;

        for (let k = 0; k < wanted.length; k++) {
            const i = wanted[k];
            report && report(k / wanted.length, `Page ${i}`);
            const page = await doc.getPage(i);
            const base = page.getViewport({ scale: 1 });
            // The page box is in points (72 per inch), so the scale that gives
            // the asked-for DPI is simply dpi/72.
            const vp = page.getViewport({ scale: Math.max(0.1, (cfg.dpi || 150) / 72) });
            const c = document.createElement('canvas');
            c.width = Math.max(1, Math.ceil(vp.width));
            c.height = Math.max(1, Math.ceil(vp.height));
            const g = c.getContext('2d', { alpha: false });
            g.fillStyle = '#FFFFFF'; g.fillRect(0, 0, c.width, c.height);
            await page.render({ canvasContext: g, viewport: vp, background: '#FFFFFF' }).promise;
            const blob = await new Promise(r => c.toBlob(r, 'image/jpeg', cfg.quality || 0.9));
            if (!blob) throw new Error('This browser could not produce a JPEG');
            entries.push({
                name: `${stem}_p${String(i).padStart(pad, '0')}.jpg`,
                data: new Uint8Array(await blob.arrayBuffer())
            });
            page.cleanup();
            void base;
        }
        return { entries, count: entries.length };
    } finally {
        task.destroy();
    }
}

// ═══════════════════════════════════════════════════════════════════════════
// TEXT EXTRACTION — the basis of PDF → Word and PDF → Excel
//
// What this can and cannot do, because the difference matters more here than
// anywhere else in this file:
//
// A PDF that was GENERATED (Crystal Reports, Tally, a shipping line's portal)
// carries its text as text, with a position for every run. That can be pulled
// out and rebuilt faithfully. A PDF that was SCANNED carries a picture of text
// and nothing else — there is no text to extract, and no amount of client-side
// cleverness invents it. That needs OCR, which needs a server.
//
// So: extract what is genuinely there, and when there is nothing there, say so
// plainly rather than handing back an empty document that looks like a bug.
// ═══════════════════════════════════════════════════════════════════════════

function xmlEsc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, c =>
        ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[c]))
        // Control characters are illegal in XML 1.0 and Word refuses the whole
        // file over a single one. Some producers emit them inside text runs.
        .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, '');
}

/**
 * Pulls every text run out with its position, grouped into visual lines.
 * Returns { pages: [ { lines: [ { y, items: [{x, w, text}] } ] } ], runs }
 */
async function extractLayout(bytes, report) {
    const pdfjs = await loadPdfJs();
    const task = pdfjs.getDocument({ data: bytes.slice(), isEvalSupported: false });
    const out = { pages: [], runs: 0 };
    try {
        const doc = await task.promise;
        for (let i = 1; i <= doc.numPages; i++) {
            report && report(0.1 + 0.6 * (i / doc.numPages), `Reading page ${i}`);
            const page = await doc.getPage(i);
            const tc = await page.getTextContent();

            const items = [];
            for (const it of tc.items) {
                const text = it.str;
                if (!text || !text.trim()) continue;
                // transform is [a,b,c,d,e,f]; e,f are the run's origin and the
                // a/d pair carries the font scale we use as a line height.
                const t = it.transform || [1, 0, 0, 1, 0, 0];
                items.push({
                    x: t[4], y: t[5],
                    h: Math.abs(t[3]) || it.height || 10,
                    w: it.width || 0,
                    text
                });
            }
            out.runs += items.length;

            // Group into lines. Runs on one visual line share a baseline, but
            // rarely to the exact point — subscripts, a taller font in the
            // middle of a row — so the tolerance is a fraction of line height.
            items.sort((a, b) => (b.y - a.y) || (a.x - b.x));
            const lines = [];
            for (const it of items) {
                const line = lines.length && Math.abs(lines[lines.length - 1].y - it.y) <= Math.max(2, it.h * 0.5)
                    ? lines[lines.length - 1] : (lines.push({ y: it.y, items: [] }), lines[lines.length - 1]);
                line.items.push(it);
            }
            lines.forEach(l => l.items.sort((a, b) => a.x - b.x));
            out.pages.push({ lines });
            page.cleanup();
        }
        return out;
    } finally {
        task.destroy();
    }
}

// A line's runs joined back into a sentence. A gap wider than a space means the
// producer moved the cursor rather than emitting a space, so one is added back.
function lineText(line) {
    let s = '';
    for (let i = 0; i < line.items.length; i++) {
        const it = line.items[i], prev = line.items[i - 1];
        if (prev) {
            const gap = it.x - (prev.x + prev.w);
            if (gap > Math.max(1.2, it.h * 0.18) && !/\s$/.test(s) && !/^\s/.test(it.text)) s += ' ';
        }
        s += it.text;
    }
    return s.replace(/\s+/g, ' ').trim();
}

// ─── PDF → Word ────────────────────────────────────────────────────────────
// A .docx is a zip of XML parts. This writes the smallest valid set: content
// types, one relationship, one document body. Paragraphs only — the text, its
// reading order and its page breaks. Not a layout clone.
function buildDocx(doc) {
    const body = [];
    doc.pages.forEach((p, pi) => {
        if (pi) body.push('<w:p><w:r><w:br w:type="page"/></w:r></w:p>');
        if (!p.lines.length) {
            body.push('<w:p><w:r><w:t xml:space="preserve"></w:t></w:r></w:p>');
            return;
        }
        for (const line of p.lines) {
            const t = lineText(line);
            if (!t) continue;
            body.push(`<w:p><w:r><w:t xml:space="preserve">${xmlEsc(t)}</w:t></w:r></w:p>`);
        }
    });

    const enc = new TextEncoder();
    const part = s => enc.encode(s);
    return makeZip([
        { name: '[Content_Types].xml', data: part(
`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
</Types>`) },
        { name: '_rels/.rels', data: part(
`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`) },
        { name: 'word/document.xml', data: part(
`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${body.join('')}<w:sectPr/></w:body></w:document>`) }
    ]);
}

// ─── PDF → Excel ───────────────────────────────────────────────────────────
// Columns are found by where text STARTS. In a generated document every cell
// in a column shares a left edge, so clustering the x positions across the page
// recovers the grid the producer laid out — without ever seeing a ruling line.
function findColumns(page, tol) {
    const pts = [];
    page.lines.forEach((line, li) => line.items.forEach(it => pts.push({ x: it.x, li })));
    if (!pts.length) return [];
    pts.sort((a, b) => a.x - b.x);

    // Cluster the left edges.
    const clusters = [];
    for (const p of pts) {
        const last = clusters[clusters.length - 1];
        if (last && p.x - last.x <= tol) { last.lines.add(p.li); last.n++; }
        else clusters.push({ x: p.x, n: 1, lines: new Set([p.li]) });
    }

    // A column is an edge that several DIFFERENT lines share. Letterhead,
    // addresses and a title each start at their own x and would otherwise
    // each invent a column — which is how a six-column invoice came out
    // seventeen columns wide, with the real table smeared across the middle.
    const real = clusters.filter(c => c.lines.size >= 2).map(c => c.x);
    // A document with no repeated alignment at all has no table in it; fall
    // back to every edge rather than collapsing everything into column A.
    return real.length >= 2 ? real : clusters.map(c => c.x);
}

function colName(n) {
    let s = '';
    n += 1;
    while (n > 0) { const r = (n - 1) % 26; s = String.fromCharCode(65 + r) + s; n = Math.floor((n - 1) / 26); }
    return s;
}

function buildXlsx(doc) {
    const rows = [];
    doc.pages.forEach((p, pi) => {
        const cols = findColumns(p, 9);
        if (pi && rows.length) rows.push([]);      // a blank row between pages
        for (const line of p.lines) {
            const cells = [];
            for (const it of line.items) {
                // Nearest column edge at or before this run.
                let c = 0;
                for (let k = 0; k < cols.length; k++) if (it.x >= cols[k] - 4) c = k;
                cells[c] = (cells[c] ? cells[c] + ' ' : '') + it.text.trim();
            }
            if (cells.some(v => v && v.trim())) rows.push(cells);
        }
    });

    const sheet = rows.map((cells, r) => {
        const cs = [];
        for (let c = 0; c < cells.length; c++) {
            const v = cells[c];
            if (v == null || v === '') continue;
            // A value that is plainly a number is written as one, so totals in
            // an extracted invoice can actually be summed in Excel.
            const num = /^-?\d{1,3}(,\d{3})*(\.\d+)?$|^-?\d+(\.\d+)?$/.test(v.trim())
                ? v.trim().replace(/,/g, '') : null;
            cs.push(num !== null
                ? `<c r="${colName(c)}${r + 1}"><v>${num}</v></c>`
                : `<c r="${colName(c)}${r + 1}" t="inlineStr"><is><t xml:space="preserve">${xmlEsc(v)}</t></is></c>`);
        }
        return `<row r="${r + 1}">${cs.join('')}</row>`;
    }).join('');

    const enc = new TextEncoder();
    const part = s => enc.encode(s);
    return {
        blob: makeZip([
            { name: '[Content_Types].xml', data: part(
`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
</Types>`) },
            { name: '_rels/.rels', data: part(
`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
</Relationships>`) },
            { name: 'xl/workbook.xml', data: part(
`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
<sheets><sheet name="Extracted" sheetId="1" r:id="rId1"/></sheets></workbook>`) },
            { name: 'xl/_rels/workbook.xml.rels', data: part(
`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>
</Relationships>`) },
            { name: 'xl/worksheets/sheet1.xml', data: part(
`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${sheet}</sheetData></worksheet>`) }
        ]),
        rows: rows.length
    };
}

async function toOffice(bytes, kind, report) {
    report && report(0.05, 'Reading text');
    const doc = await extractLayout(bytes, report);
    // The honest failure. A scan reaches here with nothing in it, and the worst
    // possible outcome is a valid, empty Word file that looks like it worked.
    if (!doc.runs) {
        throw new Error('There is no text in this PDF to convert — it is a scan, ' +
            'a picture of a document rather than a document. Pulling words out of an image ' +
            'needs OCR, which cannot run in the browser. Compress or Split will still work on it.');
    }
    report && report(0.8, 'Building file');
    if (kind === 'word') return { blob: buildDocx(doc), runs: doc.runs, pages: doc.pages.length };
    const x = buildXlsx(doc);
    return { blob: x.blob, runs: doc.runs, pages: doc.pages.length, rows: x.rows };
}

// ═══════════════════════════════════════════════════════════════════════════
// JPG → PDF — one page per image, at the image's own proportions
// ═══════════════════════════════════════════════════════════════════════════

const A4 = { w: 595.28, h: 841.89 };

async function imagesToPdf(files, cfg, report) {
    const L = await loadPdfLib();
    const doc = await L.PDFDocument.create();

    for (let i = 0; i < files.length; i++) {
        report && report(i / files.length, `Adding ${files[i].name}`);
        const f = files[i];
        let img;
        // pdf-lib embeds JPEG and PNG natively. Anything else (HEIC from a
        // phone, WebP, a TIFF from a scanner) is redrawn through a canvas
        // first, which handles whatever the browser itself can open.
        if (/^\xFF\xD8/.test(String.fromCharCode(f.bytes[0], f.bytes[1]))) {
            img = await doc.embedJpg(f.bytes);
        } else if (f.bytes[0] === 0x89 && f.bytes[1] === 0x50) {
            img = await doc.embedPng(f.bytes);
        } else {
            const bmp = await createImageBitmap(new Blob([f.bytes]));
            const c = document.createElement('canvas');
            c.width = bmp.width; c.height = bmp.height;
            const g = c.getContext('2d', { alpha: false });
            g.fillStyle = '#FFFFFF'; g.fillRect(0, 0, c.width, c.height);
            g.drawImage(bmp, 0, 0);
            bmp.close();
            const blob = await new Promise(r => c.toBlob(r, 'image/jpeg', 0.92));
            if (!blob) throw new Error(`${f.name} could not be read as an image`);
            img = await doc.embedJpg(new Uint8Array(await blob.arrayBuffer()));
        }

        if (cfg.fit === 'image') {
            // The page IS the picture — no border, no letterboxing. Right for a
            // photographed document that will be read, not printed.
            const p = doc.addPage([img.width, img.height]);
            p.drawImage(img, { x: 0, y: 0, width: img.width, height: img.height });
        } else {
            const land = cfg.fit === 'a4' && img.width > img.height;
            const pw = land ? A4.h : A4.w, ph = land ? A4.w : A4.h;
            const m = cfg.margin == null ? 28 : cfg.margin;
            const p = doc.addPage([pw, ph]);
            // Contain, never crop: the whole image survives, centred.
            const s = Math.min((pw - m * 2) / img.width, (ph - m * 2) / img.height);
            const w = img.width * s, h = img.height * s;
            p.drawImage(img, { x: (pw - w) / 2, y: (ph - h) / 2, width: w, height: h });
        }
    }
    if (!doc.getPageCount()) throw new Error('No images could be read');
    report && report(0.95, 'Saving');
    return { bytes: await doc.save({ useObjectStreams: true }), pages: doc.getPageCount() };
}

// ─── Public surface ────────────────────────────────────────────────────────
window.PdfTools = {
    extractLayout, buildDocx, buildXlsx, toOffice, imagesToPdf,
    compress, merge, split, extractPages, parsePageSpec,
    rotatePages, organisePages, numberPages, watermarkPdf, pagesToImages,
    makeZip, fmtSize, pct, PRESETS,
    loadPdfLib, loadPdfJs
};
})();
