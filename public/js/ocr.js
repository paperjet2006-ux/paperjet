/* ═══════════════════════════════════════════════════════════════════════════
   OCR — reading the words out of a scan
   ═══════════════════════════════════════════════════════════════════════════

   Everything else on this site works on documents that already contain text.
   A scan does not: it is a picture of a document, and there is nothing inside
   it to pull out. OCR is the one tool that manufactures the text rather than
   recovering it, which makes it both the most useful thing here and the only
   one that can be confidently wrong.

   It still runs entirely in this browser. Tesseract is compiled to WebAssembly
   and served from this origin along with its English model — about 18 MB, all
   of it fetched only when someone actually asks for OCR, and never again after
   the browser caches it. The page a scan is on is drawn to a canvas and handed
   to that WASM worker. No image, and no text recovered from one, is sent
   anywhere.

   ── Two outputs, and why the second one matters more ──────────────────────
   TEXT / WORD / EXCEL — the recognised words, as an editable document.
   SEARCHABLE PDF     — the original scan, untouched, with the recognised text
                        laid over it as an invisible layer. The page still
                        looks exactly like the scan, because it IS the scan;
                        but Cmd-F finds things, and text can be selected and
                        copied. Nothing is thrown away, so a wrong reading is
                        a failed search rather than a corrupted document. For
                        a BL or an invoice that is almost always the right
                        choice, and it is the default here for that reason.

   ── On accuracy ───────────────────────────────────────────────────────────
   Clean 300 DPI print scans come out very well. Faint carbon copies, stamps
   over text, skew, handwriting and dot-matrix do not. The confidence figure
   returned per page is Tesseract's own, and the UI shows it rather than
   hiding it — a number in the fifties means "read this before trusting it".
   ═════════════════════════════════════════════════════════════════════════ */
(function () {
'use strict';

const VENDOR = '/vendor/tesseract/';

// Rendering resolution for the page handed to OCR. Tesseract is trained around
// 300 DPI and degrades noticeably below ~200; above 300 it gets slower without
// getting better, and a big scan starts to risk the canvas size limits that
// mobile Safari enforces. 300 unless the page is large enough that 300 would
// be reckless, in which case as close to it as fits.
const OCR_DPI = 300;
const MAX_PIXELS = 40e6;   // ~40 MP — beyond this Safari returns a blank canvas

let _tessP = null;

// Tesseract's own script, loaded on demand. Nobody who never touches OCR
// should pay for 18 MB, so nothing here is fetched until the first run.
function loadTesseract() {
    if (_tessP) return _tessP;
    _tessP = new Promise((resolve, reject) => {
        if (window.Tesseract) return resolve(window.Tesseract);
        const s = document.createElement('script');
        s.src = VENDOR + 'tesseract.min.js';
        s.onload = () => window.Tesseract ? resolve(window.Tesseract)
            : reject(new Error('Tesseract failed to initialise'));
        s.onerror = () => reject(new Error('Could not load the OCR engine'));
        document.head.appendChild(s);
    });
    return _tessP;
}

// One worker, reused across pages and across runs. Spinning it up costs a
// couple of seconds and loads the language model; doing that per page would
// dominate the running time of any multi-page document.
let _worker = null, _workerP = null;

async function getWorker(report) {
    if (_worker) return _worker;
    if (_workerP) return _workerP;
    _workerP = (async () => {
        const T = await loadTesseract();
        report && report(0.04, 'Starting the OCR engine');
        const w = await T.createWorker('eng', 1, {
            workerPath: VENDOR + 'worker.min.js',
            corePath:   VENDOR,
            langPath:   VENDOR + 'lang',
            // The model ships gzipped and is served that way; saying so stops
            // Tesseract looking for an uncompressed copy that is not there.
            gzip: true,
            logger: m => {
                if (!report || m.status !== 'recognizing text') return;
                report(null, null, m.progress);   // sub-progress within a page
            }
        });
        _worker = w;
        return w;
    })();
    return _workerP;
}

// Released when the page is done with OCR — the worker holds the language
// model in memory, which is worth reclaiming on a machine with 8 GB.
async function release() {
    const w = _worker;
    _worker = null; _workerP = null;
    if (w) { try { await w.terminate(); } catch (e) { /* already gone */ } }
}

// ─── Rendering a page for OCR ──────────────────────────────────────────────
// Deliberately not the same render as the thumbnails: those are small and fast
// and would give Tesseract almost nothing to work with.
async function renderForOcr(page) {
    let scale = OCR_DPI / 72;
    const base = page.getViewport({ scale: 1 });
    // Step the scale back rather than refuse the page outright — a large
    // drawing at 200 DPI still reads, and a blank canvas reads as nothing.
    if (base.width * base.height * scale * scale > MAX_PIXELS) {
        scale = Math.sqrt(MAX_PIXELS / (base.width * base.height));
    }
    const viewport = page.getViewport({ scale });
    const canvas = document.createElement('canvas');
    canvas.width = Math.floor(viewport.width);
    canvas.height = Math.floor(viewport.height);
    const ctx = canvas.getContext('2d', { alpha: false });
    // White, not transparent-black. A scan with a transparent background
    // otherwise reaches Tesseract as white-on-black and recognises as noise.
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    await page.render({ canvasContext: ctx, viewport, intent: 'print' }).promise;
    normalise(ctx, canvas.width, canvas.height);
    return { canvas, scale, width: viewport.width, height: viewport.height };
}

/**
 * Lift the ink off the paper before Tesseract ever sees it.
 *
 * This is not a nicety. Office scanners routinely produce documents whose body
 * text is pale grey on white — a CONCOR trade notice came through with 0.7% of
 * its pixels dark, and Tesseract read 36 words of noise from it at 22%
 * confidence because there was barely any ink to find. A person reads a faint
 * page without noticing it is faint; the engine cannot.
 *
 * Two approaches were tried and rejected before this one, and both failures are
 * worth keeping because they are the obvious things to reach for:
 *
 *   A GLOBAL CONTRAST STRETCH does nothing here. That page carries a black
 *   logo, black stamps and crisp black digits alongside the near-white
 *   paragraph, so globally it already spans full black to full white; any
 *   global correction concludes there is nothing to fix. 22% → 37%.
 *
 *   SAUVOLA THRESHOLDING made it worse — 28% — and inspecting the output
 *   showed why: it deleted the faint text outright. Where text is only just
 *   darker than paper the local standard deviation is tiny, so the threshold
 *   m·(1 + k·(s/R − 1)) falls BELOW the text and classifies it as paper. Every
 *   local thresholding scheme has this failure mode; the page that needs help
 *   most is the page it erases.
 *
 * What works is not deciding ink-or-paper at all, but measuring how much darker
 * than its surroundings each pixel is, and amplifying that difference:
 *
 *     out = 255 − (localPaper − pixel − deadzone) · GAIN
 *
 * Fifteen levels of difference — invisible to Tesseract — become a hundred and
 * eighty. Genuinely black content saturates and stays black. Flat paper has a
 * difference of zero and stays white, with a small deadzone so scanner grain is
 * not amplified into a grey haze. Nothing is thrown away: faint strokes get
 * darker rather than being judged and deleted.
 */
const BG_RADIUS = 16;   // at quarter scale ≈ 64px at 300 DPI — well wider than a letter
const GAIN = 11;        // 15 levels of faintness → ~165 levels of darkness
const DEADZONE = 4;     // scanner grain, left alone

function normalise(ctx, w, h) {
    const img = ctx.getImageData(0, 0, w, h);
    const d = img.data;

    // ── Only treat pages that need it ─────────────────────────────────────
    // Amplification helps a starved page enormously and costs a healthy one
    // accuracy: on a good 300 DPI scan it dragged confidence from 86% down to
    // 78% by dragging up scanner grain and edge shadows along with the ink.
    // The two cases separate cleanly by how much ink is on the page at all —
    // that good scan reads 5.3% dark pixels, the faint trade notice 0.9% — so
    // anything with a normal amount of ink is left exactly as it was.
    let dark = 0, n = 0;
    for (let i = 0; i < d.length; i += 4 * 16) {
        if (d[i] * 0.299 + d[i + 1] * 0.587 + d[i + 2] * 0.114 < 140) dark++;
        n++;
    }
    if (!n || dark / n > 0.02) return;

    // ── Quarter-scale grey copy. The background estimate is a wide average, so
    //    computing it at full resolution buys nothing and costs ~100 MB. ──
    const sw = Math.max(1, w >> 2), sh = Math.max(1, h >> 2);
    const small = new Float64Array(sw * sh);
    for (let y = 0; y < sh; y++) {
        for (let x = 0; x < sw; x++) {
            const i = ((y << 2) * w + (x << 2)) << 2;
            small[y * sw + x] = d[i] * 0.299 + d[i + 1] * 0.587 + d[i + 2] * 0.114;
        }
    }

    // ── Summed-area table, so a wide box average is four reads per pixel ──
    const iw = sw + 1, ih = sh + 1;
    const sum = new Float64Array(iw * ih);
    for (let y = 1; y < ih; y++) {
        let row = 0;
        for (let x = 1; x < iw; x++) {
            row += small[(y - 1) * sw + (x - 1)];
            sum[y * iw + x] = sum[(y - 1) * iw + x] + row;
        }
    }

    // ── Local paper level ──
    // The mean is pulled down by whatever ink sits in the window, which would
    // under-state the paper and wash out dense text. Adding back a share of the
    // shortfall biases the estimate towards the brighter (paper) side without
    // the cost of a true percentile filter.
    const bg = new Float64Array(sw * sh);
    for (let y = 0; y < sh; y++) {
        const y0 = Math.max(0, y - BG_RADIUS), y1 = Math.min(sh, y + BG_RADIUS + 1);
        for (let x = 0; x < sw; x++) {
            const x0 = Math.max(0, x - BG_RADIUS), x1 = Math.min(sw, x + BG_RADIUS + 1);
            const area = (x1 - x0) * (y1 - y0);
            const mean = (sum[y1 * iw + x1] - sum[y0 * iw + x1]
                        - sum[y1 * iw + x0] + sum[y0 * iw + x0]) / area;
            bg[y * sw + x] = Math.min(255, mean * 1.06 + 3);
        }
    }

    // ── Amplify, at full resolution ──
    for (let y = 0; y < h; y++) {
        const sy = Math.min(sh - 1, y >> 2);
        for (let x = 0; x < w; x++) {
            const i = (y * w + x) << 2;
            const g = d[i] * 0.299 + d[i + 1] * 0.587 + d[i + 2] * 0.114;
            const diff = bg[sy * sw + Math.min(sw - 1, x >> 2)] - g - DEADZONE;
            const v = diff <= 0 ? 255 : Math.max(0, 255 - diff * GAIN);
            d[i] = d[i + 1] = d[i + 2] = v;
        }
    }
    ctx.putImageData(img, 0, 0);
}

// ─── Words → the shape the rest of the site already understands ────────────
// The engine's Word and Excel builders take a page of positioned text runs and
// work out lines and columns from where things sit. Tesseract gives exactly
// that — a bounding box per word — so OCR output is converted into the same
// shape rather than given its own half-clever exporter. The column inference
// that recovers a table from a generated invoice then recovers one from a
// scanned invoice too, for free.
//
// The one adjustment is the y axis: image coordinates grow downwards, PDF
// coordinates grow upwards, and the builders assume PDF.
function wordsToPage(words, imgHeight, scale) {
    const items = [];
    for (const w of words) {
        const text = (w.text || '').trim();
        if (!text) continue;
        const b = w.bbox || {};
        const h = Math.max(1, (b.y1 - b.y0)) / scale;
        items.push({
            x: b.x0 / scale,
            y: (imgHeight - b.y1) / scale,   // flip to a PDF-style origin
            w: (b.x1 - b.x0) / scale,
            h,
            text
        });
    }
    items.sort((a, b) => (b.y - a.y) || (a.x - b.x));

    const lines = [];
    for (const it of items) {
        const last = lines[lines.length - 1];
        const line = last && Math.abs(last.y - it.y) <= Math.max(2, it.h * 0.5)
            ? last : (lines.push({ y: it.y, items: [] }), lines[lines.length - 1]);
        line.items.push(it);
    }
    lines.forEach(l => l.items.sort((a, b) => a.x - b.x));
    return { lines };
}

/**
 * Reads every page of a PDF and returns both the layout structure the Word and
 * Excel builders take, and the plain text.
 * → { pages, runs, text, confidence, perPage: [{ page, confidence, words }] }
 */
async function readPdf(bytes, opts, report) {
    const cfg = opts || {};
    const pdfjs = await window.PdfTools.loadPdfJs();
    const worker = await getWorker(report);

    const task = pdfjs.getDocument({ data: bytes.slice(), isEvalSupported: false });
    const out = { pages: [], runs: 0, text: '', perPage: [] };
    const texts = [];
    let confSum = 0, confN = 0;

    try {
        const doc = await task.promise;
        const only = cfg.pages && cfg.pages.length ? cfg.pages : null;
        const list = only || Array.from({ length: doc.numPages }, (_, i) => i + 1);

        for (let k = 0; k < list.length; k++) {
            const n = list[k];
            // Two-part progress: which page, and how far into it. Without the
            // second part a 12-page scan looks frozen for a minute at a time.
            const span = 1 / list.length;
            const base = 0.08 + 0.88 * (k * span);
            const rep = (sub) => report && report(base + 0.88 * span * (sub || 0),
                `Reading page ${n} of ${list.length}`);
            rep(0);

            const page = await doc.getPage(n);
            const { canvas, scale, height } = await renderForOcr(page);

            const res = await worker.recognize(canvas, {}, { blocks: true, text: true });
            const data = res.data || {};

            // v5 returns paragraphs→lines→words under blocks; flatten to words.
            const words = [];
            for (const blk of (data.blocks || [])) {
                for (const par of (blk.paragraphs || [])) {
                    for (const ln of (par.lines || [])) {
                        for (const w of (ln.words || [])) words.push(w);
                    }
                }
            }

            const pg = wordsToPage(words, height, scale);
            out.pages.push(pg);
            out.runs += words.length;
            texts.push(data.text || '');
            if (typeof data.confidence === 'number') { confSum += data.confidence; confN++; }
            out.perPage.push({ page: n, confidence: data.confidence || 0, words: words.length });

            // The canvas is the single biggest object here — a 300 DPI A4 page
            // is ~35 MB of pixels. Dropped explicitly so a 40-page scan does
            // not hold all of them at once waiting for a collection.
            canvas.width = canvas.height = 0;
            page.cleanup();
            rep(1);
        }

        out.text = texts.join('\n\n');
        out.confidence = confN ? Math.round(confSum / confN) : 0;
        return out;
    } finally {
        task.destroy();
    }
}

/**
 * The original scan with an invisible text layer over it. Tesseract writes a
 * one-page PDF per page; pdf-lib stitches them back into one document.
 * → { bytes, pages, confidence }
 */
async function searchablePdf(bytes, opts, report) {
    const cfg = opts || {};
    const pdfjs = await window.PdfTools.loadPdfJs();
    const L = await window.PdfTools.loadPdfLib();
    const worker = await getWorker(report);

    const task = pdfjs.getDocument({ data: bytes.slice(), isEvalSupported: false });
    let confSum = 0, confN = 0;

    try {
        const doc = await task.promise;
        const out = await L.PDFDocument.create();
        const n = doc.numPages;

        for (let i = 1; i <= n; i++) {
            const span = 1 / n, base = 0.08 + 0.86 * ((i - 1) * span);
            const rep = (sub) => report && report(base + 0.86 * span * (sub || 0),
                `Reading page ${i} of ${n}`);
            rep(0);

            const page = await doc.getPage(i);
            const { canvas } = await renderForOcr(page);

            const res = await worker.recognize(canvas, {}, { pdf: true });
            const pdfBytes = res.data && res.data.pdf;
            if (!pdfBytes) throw new Error('The OCR engine did not return a PDF for page ' + i);
            if (typeof res.data.confidence === 'number') { confSum += res.data.confidence; confN++; }

            const one = await L.PDFDocument.load(new Uint8Array(pdfBytes), { ignoreEncryption: true });
            const copied = await out.copyPages(one, one.getPageIndices());
            copied.forEach(p => out.addPage(p));

            canvas.width = canvas.height = 0;
            page.cleanup();
            rep(1);
        }

        report && report(0.96, 'Saving');
        return {
            bytes: await out.save({ useObjectStreams: true }),
            pages: out.getPageCount(),
            confidence: confN ? Math.round(confSum / confN) : 0
        };
    } finally {
        task.destroy();
    }
}

// Images rather than a PDF — a photo of a document, straight to text.
async function readImages(files, opts, report) {
    const worker = await getWorker(report);
    const texts = [];
    let confSum = 0, confN = 0;
    for (let i = 0; i < files.length; i++) {
        report && report(0.08 + 0.88 * (i / files.length), `Reading ${files[i].name}`);
        const url = URL.createObjectURL(new Blob([files[i].bytes]));
        try {
            const res = await worker.recognize(url, {}, { text: true });
            texts.push((res.data && res.data.text) || '');
            if (res.data && typeof res.data.confidence === 'number') {
                confSum += res.data.confidence; confN++;
            }
        } finally { URL.revokeObjectURL(url); }
    }
    return {
        text: texts.join('\n\n'),
        pages: files.length,
        confidence: confN ? Math.round(confSum / confN) : 0
    };
}

window.PdfOcr = { readPdf, searchablePdf, readImages, release, loadTesseract, normalise };

})();
