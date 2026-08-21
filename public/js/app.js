/* ═══════════════════════════════════════════════════════════════════════════
   PAPERJET — UI
   ═══════════════════════════════════════════════════════════════════════════
   The engine (pdf-engine.js) and the OCR module (ocr.js) know nothing about
   this file; everything here is presentation and orchestration. One entry in
   TOOLS per tool describes what it is, what it accepts and how it runs, so
   adding the twelfth is a new entry and a run function rather than an edit in
   nine places.
   ═════════════════════════════════════════════════════════════════════════ */
(function () {
'use strict';

const BUILD = (document.currentScript && document.currentScript.src) || 'unknown';
const $ = id => document.getElementById(id);
const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const E = () => window.PdfTools;
const fmtSize = n => E().fmtSize(n);

const S = {
    tool: null,
    files: [],            // { name, size, bytes, pageCount }
    preset: 'balanced',
    splitMode: 'extract',
    everyN: 10,
    angle: 90,
    dpi: 150,
    num: { position: 'bottom-centre', format: '{n}', from: 1, start: 1, size: 11 },
    fit: 'a4',
    wm: { text: 'DRAFT', opacity: 12, angle: 45 },
    ocrOut: 'pdf',        // pdf | text | word | excel
    selected: new Set(),
    busy: false,
    ocrAnyway: false,
    lastUrl: null,
    lastDiag: ''
};

const ico = p => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"
    stroke-linecap="round" stroke-linejoin="round">${p}</svg>`;

/* Accents are CSS variables, not hex. The light theme redefines each of these
   to an accessible twin (measured >=4.5:1, since --tool is used for icons and
   text as well as borders); writing raw hex here would set the dark-theme neon
   on documentElement and override that, which is exactly what it used to do. */
const TOOLS = {
    ocr: {
        name: 'OCR a scan', accent: 'var(--cyan)', accent2: 'var(--magenta)', tag: 'new',
        multi: false, accept: 'application/pdf',
        icon: ico('<path d="M3 7V5a2 2 0 0 1 2-2h2M17 3h2a2 2 0 0 1 2 2v2M21 17v2a2 2 0 0 1-2 2h-2M7 21H5a2 2 0 0 1-2-2v-2"/><path d="M7 12h10"/>'),
        desc: 'Read the words out of a scanned document — and make it searchable.',
        blurb: 'A scan is a picture of a document: there is no text inside it to find, copy or search. This reads the words off the picture and puts them back in. The default keeps your scan exactly as it looks and lays the text over it invisibly, so nothing is lost even where the reading is imperfect.'
    },
    compress: {
        name: 'Compress', accent: 'var(--red)', accent2: 'var(--magenta)',
        multi: false, accept: 'application/pdf',
        icon: ico('<path d="M4 14h6v6M20 10h-6V4M14 10l7-7M3 21l7-7"/>'),
        desc: 'Shrink a PDF as far as it goes without the quality showing.',
        blurb: 'Images inside the file are recompressed but text stays text, so the result is still selectable and searchable. Need it smaller? Run the result through again at a stronger level.'
    },
    merge: {
        name: 'Merge', accent: 'var(--cyan)', accent2: 'var(--violet)',
        multi: true, accept: 'application/pdf',
        icon: ico('<path d="M8 3H5a2 2 0 0 0-2 2v3M21 8V5a2 2 0 0 0-2-2h-3M3 16v3a2 2 0 0 0 2 2h3M16 21h3a2 2 0 0 0 2-2v-3"/>'),
        desc: 'Join several PDFs into one, in the order you list them.',
        blurb: 'Every page is copied across exactly as it was — no re-rendering, so nothing is lost. They merge in the order shown; remove one and drop it back to move it to the end.'
    },
    split: {
        name: 'Split', accent: 'var(--violet)', accent2: 'var(--cyan)',
        multi: false, accept: 'application/pdf',
        icon: ico('<path d="M12 3v18M5 8l-2 4 2 4M19 8l2 4-2 4"/>'),
        desc: 'Pull pages out, drop pages, or break a file into pieces.',
        blurb: 'Pick pages on the grid, or type a range like 1-3, 7, 12-. Nothing is re-rendered — the pages you keep are byte-for-byte the pages you had.'
    },
    organize: {
        name: 'Organize', accent: 'var(--violet)', accent2: 'var(--amber)', tag: 'new',
        multi: false, accept: 'application/pdf',
        icon: ico('<rect x="2.5" y="4" width="7" height="9" rx="1.4"/><rect x="14.5" y="11" width="7" height="9" rx="1.4"/><path d="M12.6 7.5h4.2"/><path d="M15.1 5.6l2.1 1.9-2.1 1.9"/><path d="M11.4 16.5H7.2"/><path d="M8.9 14.6l-2.1 1.9 2.1 1.9"/>'),
        desc: 'Drag pages into the order you want them.',
        blurb: 'The tool for a file that arrived in the wrong order. Drag any page to move it; each one can also be turned, duplicated or removed on its own. Pages are copied, never re-rendered, so nothing loses quality — and nothing is written until you press the button.'
    },
    rotate: {
        name: 'Rotate', accent: 'var(--amber)', accent2: 'var(--magenta)',
        multi: false, accept: 'application/pdf',
        icon: ico('<path d="M21 2v6h-6"/><path d="M3 12a9 9 0 0 1 15-6.7L21 8"/><path d="M3 22v-6h6"/><path d="M21 12a9 9 0 0 1-15 6.7L3 16"/>'),
        desc: 'Turn pages the right way up. Completely lossless.',
        blurb: 'Only the rotation flag moves — not a single pixel is re-encoded. Pick pages on the grid to turn just those, or leave none picked to turn the whole document.'
    },
    numbers: {
        name: 'Page numbers', accent: 'var(--cyan)', accent2: 'var(--lime)',
        multi: false, accept: 'application/pdf',
        icon: ico('<path d="M4 4h16v16H4z"/><path d="M9 16h6"/><path d="M12 16v-6l-2 1"/>'),
        desc: 'Stamp page numbers where you want them.',
        blurb: 'Drawn as real text, so they stay crisp at any zoom. Sideways pages are handled properly — "bottom centre" means the bottom centre of the page as you see it, not as it happens to be stored.'
    },
    watermark: {
        name: 'Watermark', accent: 'var(--magenta)', accent2: 'var(--violet)',
        multi: false, accept: 'application/pdf',
        icon: ico('<path d="M12 3l7 7a7 7 0 1 1-14 0z"/>'),
        desc: 'Lay a word across every page — DRAFT, COPY, a client name.',
        blurb: 'Real text at the opacity you choose, so it stays crisp at any zoom and never covers what is underneath. On a sideways page it stays diagonal to the reader, not to the file.'
    },
    tojpg: {
        name: 'PDF → JPG', accent: 'var(--lime)', accent2: 'var(--cyan)',
        multi: false, accept: 'application/pdf',
        icon: ico('<path d="M3 5h18v14H3z"/><circle cx="8.5" cy="10" r="1.5"/><path d="M21 15l-5-5L5 19"/>'),
        desc: 'One image per page, at whatever resolution you need.',
        blurb: 'Every page is rendered at the resolution you pick and delivered as a zip. 150 DPI reads well on screen; 300 is what you want if the images are going to be printed.'
    },
    fromjpg: {
        name: 'JPG → PDF', accent: 'var(--lime)', accent2: 'var(--amber)',
        multi: true, accept: 'image/*',
        icon: ico('<path d="M4 3h16v18H4z"/><path d="M9 9h6v6H9z"/>'),
        desc: 'Turn photos or scans into a single PDF.',
        blurb: 'One page per image, in the order listed. JPEGs and PNGs go in untouched, so the pictures stay exactly as sharp as they were. Anything else is converted first.'
    },
    toword: {
        name: 'PDF → Word', accent: 'var(--violet)', accent2: 'var(--cyan)',
        multi: false, accept: 'application/pdf',
        icon: ico('<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/><path d="M8 13h8M8 17h5"/>'),
        desc: 'Pull the text into an editable Word document.',
        blurb: 'Works on PDFs a system generated — invoices, statements, portal printouts. The words and their reading order come across; layout, images and exact fonts do not. If the file is a scan you will be told so, and pointed at OCR.'
    },
    toexcel: {
        name: 'PDF → Excel', accent: 'var(--lime)', accent2: 'var(--cyan)',
        multi: false, accept: 'application/pdf',
        icon: ico('<path d="M4 4h16v16H4z"/><path d="M4 10h16M10 4v16"/>'),
        desc: 'Recover a table into a spreadsheet you can actually sum.',
        blurb: 'Columns are found from where the text sits on the page, so a real table keeps its shape and numbers arrive as numbers. A form-style layout comes across complete but more scattered than you would draw by hand.'
    }
};

// ═══ Home ═══════════════════════════════════════════════════════════════════
function paintHome() {
    $('toolGrid').innerHTML = Object.keys(TOOLS).map(k => {
        const t = TOOLS[k];
        return `<button class="tool-card" style="--tool:${t.accent}" onclick="pjOpen('${k}')"
            onmousemove="pjCardGlow(event,this)">
            ${t.tag ? `<span class="tool-tag">${esc(t.tag)}</span>` : ''}
            <div class="tool-ico">${t.icon}</div>
            <div class="tool-name">${esc(t.name)}</div>
            <div class="tool-desc">${esc(t.desc)}</div>
        </button>`;
    }).join('');
}

window.pjCardGlow = function (ev, el) {
    const r = el.getBoundingClientRect();
    el.style.setProperty('--mx', (ev.clientX - r.left) + 'px');
    el.style.setProperty('--my', (ev.clientY - r.top) + 'px');
};

window.pjHome = function () {
    S.tool = null;
    $('home').style.display = '';
    $('ws').classList.remove('on');
    window.scrollTo({ top: 0, behavior: 'smooth' });
};

window.pjOpen = function (tool) {
    S.tool = tool;
    const t = TOOLS[tool];
    document.documentElement.style.setProperty('--tool', t.accent);
    document.documentElement.style.setProperty('--tool-2', t.accent2);
    $('home').style.display = 'none';
    $('ws').classList.add('on');
    $('wsTitle').textContent = t.name;
    $('fileInput').multiple = !!t.multi;
    $('fileInput').accept = t.accept;
    pjReset();
    window.scrollTo({ top: 0 });
};

// ═══ Files ══════════════════════════════════════════════════════════════════
async function addFiles(list) {
    const t = TOOLS[S.tool];
    const incoming = Array.from(list || []);
    if (!incoming.length) return;
    if (!t.multi) S.files = [];

    for (const f of incoming) {
        const isPdf = /\.pdf$/i.test(f.name) || f.type === 'application/pdf';
        if (t.accept === 'application/pdf' && !isPdf) { toast(`${f.name} is not a PDF`, 'err'); continue; }
        if (t.accept === 'image/*' && !/^image\//.test(f.type)) { toast(`${f.name} is not an image`, 'err'); continue; }
        const bytes = new Uint8Array(await f.arrayBuffer());
        const rec = { name: f.name, size: f.size, bytes, pageCount: null };
        if (isPdf) {
            try {
                const L = await E().loadPdfLib();
                const d = await L.PDFDocument.load(bytes, { ignoreEncryption: true, updateMetadata: false });
                rec.pageCount = d.getPageCount();
            } catch (e) { toast(`${f.name} could not be read — it may be damaged or password-protected`, 'err'); continue; }
        }
        S.files.push(rec);
        if (!t.multi) break;
    }
    S.selected.clear();
    // A new file means a new arrangement — the old one described a document
    // that is no longer loaded.
    S.order = []; S.orderFor = '';
    render();
    if (S.files.length && TOOLS[S.tool].accept === 'application/pdf') {
        if (S.tool === 'organize') organizeGrid(); else thumbs();
    }
}

window.pjRemove = function (i) {
    S.files.splice(i, 1); S.selected.clear();
    S.order = []; S.orderFor = '';
    render();
    if (S.files.length) { if (S.tool === 'organize') organizeGrid(); else thumbs(); }
    else $('pages').hidden = true;
};
window.pjReset = function () {
    S.files = []; S.selected.clear(); S.lastDiag = '';
    S.order = []; S.orderFor = '';
    if (orgCleanup) { orgCleanup(); orgCleanup = null; }
    if (orgObserver) { orgObserver.disconnect(); orgObserver = null; }
    if (S.lastUrl) { URL.revokeObjectURL(S.lastUrl); S.lastUrl = null; }
    $('result').innerHTML = ''; $('prog').style.display = 'none'; $('pages').hidden = true;
    $('pages').innerHTML = ''; $('fileInput').value = '';
    render();
};

// ═══ Thumbnails ═════════════════════════════════════════════════════════════
let thumbToken = 0;
async function thumbs() {
    const f = S.files[0];
    if (!f || !f.pageCount) return;
    const me = ++thumbToken;
    const box = $('pages');
    const n = Math.min(f.pageCount, 60);
    box.hidden = false;
    box.innerHTML = Array.from({ length: n }, (_, i) =>
        `<div class="page page-skel" data-p="${i + 1}"><span class="page-n">${i + 1}</span></div>`).join('');
    paintPageModes();

    try {
        const pdfjs = await E().loadPdfJs();
        const task = pdfjs.getDocument({ data: f.bytes.slice(), isEvalSupported: false });
        const doc = await task.promise;
        for (let i = 1; i <= n; i++) {
            if (me !== thumbToken) { task.destroy(); return; }
            const page = await doc.getPage(i);
            const vp0 = page.getViewport({ scale: 1 });
            const scale = 150 / vp0.width;
            const vp = page.getViewport({ scale });
            const c = document.createElement('canvas');
            c.width = Math.floor(vp.width); c.height = Math.floor(vp.height);
            const ctx = c.getContext('2d', { alpha: false });
            ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height);
            await page.render({ canvasContext: ctx, viewport: vp }).promise;
            const el = box.querySelector(`[data-p="${i}"]`);
            if (el) { el.classList.remove('page-skel'); el.insertBefore(c, el.firstChild); applyRotationPreview(); }
            page.cleanup();
        }
        task.destroy();
    } catch (e) { /* previews are a convenience; failing to draw one is not fatal */ }
}


/* ═══ Organize ══════════════════════════════════════════════════════════════
   Every other tool asks you to describe pages in a box — "3, 7, 12-15". Putting
   a bundle in order is where that breaks down: it is a thing you do by looking
   at the pages, and no page-range syntax expresses "this annexure belongs
   behind that invoice".

   The arrangement is an ARRAY, not marks on the original: its order is the page
   order, its length is the page count, and a page missing from it is a page
   removed. Duplicating then falls out for free — the same page twice in the
   array is the same page twice in the document.

   This draws its own grid rather than reusing thumbs(), for one reason that
   matters: thumbs() stops at 60 pages. Reordering a truncated view and
   rebuilding from it would silently drop every page past the cap. Here every
   page is present, and the canvases are drawn lazily as they come into view so
   a 300-page file still opens at once.
   ═══════════════════════════════════════════════════════════════════════════ */

S.order = [];
S.orderFor = '';

function orderSig() {
    const f = S.files[0];
    return f ? `${f.name}|${f.size}|${f.pageCount}` : '';
}

function ensureOrder() {
    const sig = orderSig();
    if (!sig) { S.order = []; S.orderFor = ''; return; }
    if (S.orderFor === sig && Array.isArray(S.order) && S.order.length) return;
    S.order = Array.from({ length: S.files[0].pageCount || 0 }, (_, i) => ({ p: i + 1, r: 0 }));
    S.orderFor = sig;
}

function orderChanged() {
    const n = S.files[0]?.pageCount || 0;
    return S.order.length !== n || S.order.some((o, i) => o.p !== i + 1 || o.r);
}

const ORG_ICONS = {
    left:  '<path d="M15 18l-6-6 6-6"/>',
    right: '<path d="M9 18l6-6-6-6"/>',
    ccw:   '<path d="M1 4v6h6"/><path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10"/>',
    cw:    '<path d="M23 4v6h-6"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/>',
    del:   '<path d="M3 6h18"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6M14 11v6"/>',
    copy:  '<rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>'
};
const orgBtn = (title, path, click, cls) =>
    `<button type="button" class="org-btn ${cls || ''}" title="${title}" aria-label="${title}"
             onclick="event.stopPropagation();${click}">${ico(path)}</button>`;

let orgObserver = null, orgCleanup = null;

/**
 * The element that actually scrolls this grid, for the lazy-render observer.
 *
 * It matters which: an IntersectionObserver rooted on the viewport computes its
 * pre-load margin against the viewport, so inside a container that scrolls on
 * its own nothing is ever drawn AHEAD of the scroll — every drag down waits on
 * a fresh render. The grid here sits in a container with its own max-height on
 * a wide screen and in the page itself on a narrow one, so this is looked up
 * rather than assumed.
 */
function scrollParent(el) {
    for (let n = el; n && n !== document.body; n = n.parentElement) {
        const oy = getComputedStyle(n).overflowY;
        if ((oy === 'auto' || oy === 'scroll') && n.scrollHeight > n.clientHeight + 1) return n;
    }
    return null;   // null = the viewport
}

function organizeGrid() {
    const box = $('pages');
    const f = S.files[0];
    if (!box || !f) return;
    ensureOrder();
    const me = ++thumbToken;
    box.hidden = false;

    box.innerHTML = S.order.map((o, i) => `
        <div class="page page-org page-skel${o.r % 180 ? ' turned' : ''}"
             data-idx="${i}" data-p="${o.p}" draggable="true"
             ondragstart="pjOrgDragStart(event,${i})" ondragend="pjOrgDragEnd(event)"
             ondragover="pjOrgDragOver(event,${i})" ondrop="pjOrgDrop(event,${i})"
             title="Drag to move">
            <span class="page-n">${i + 1}</span>
            <span class="page-src">was ${o.p}</span>
            <div class="org-bar org-bar-top">
                ${orgBtn('Duplicate this page', ORG_ICONS.copy, `pjOrgDuplicate(${i})`)}
                ${orgBtn('Remove this page', ORG_ICONS.del, `pjOrgDelete(${i})`, 'danger')}
            </div>
            <div class="org-bar">
                ${orgBtn('Move earlier', ORG_ICONS.left, `pjOrgMove(${i},${i - 1})`)}
                ${orgBtn('Turn left', ORG_ICONS.ccw, `pjOrgRotate(${i},-90)`)}
                ${orgBtn('Turn right', ORG_ICONS.cw, `pjOrgRotate(${i},90)`)}
                ${orgBtn('Move later', ORG_ICONS.right, `pjOrgMove(${i},${i + 1})`)}
            </div>
        </div>`).join('');

    // One render per ORIGINAL page, reused wherever it appears, so a duplicated
    // page costs nothing to show.
    const cache = new Map();
    let doc = null, task = null;

    const draw = async (el) => {
        const p = Number(el.dataset.p);
        try {
            if (!doc) {
                const pdfjs = await E().loadPdfJs();
                if (me !== thumbToken) return;
                task = pdfjs.getDocument({ data: f.bytes.slice(), isEvalSupported: false });
                doc = await task.promise;
            }
            if (me !== thumbToken) return;
            if (!cache.has(p)) {
                const page = await doc.getPage(p);
                const vp0 = page.getViewport({ scale: 1 });
                const vp = page.getViewport({ scale: 150 / vp0.width });
                const c = document.createElement('canvas');
                c.width = Math.floor(vp.width); c.height = Math.floor(vp.height);
                const ctx = c.getContext('2d', { alpha: false });
                ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height);
                await page.render({ canvasContext: ctx, viewport: vp }).promise;
                page.cleanup();
                cache.set(p, c.toDataURL('image/jpeg', 0.8));
            }
            if (me !== thumbToken || !el.isConnected) return;
            const img = new Image();
            img.src = cache.get(p);
            const o = S.order[Number(el.dataset.idx)];
            if (o && o.r) img.style.transform = `rotate(${o.r}deg)`;
            el.classList.remove('page-skel');
            el.insertBefore(img, el.firstChild);
        } catch (e) { /* a preview that will not draw is not worth failing over */ }
    };

    if (orgObserver) orgObserver.disconnect();
    orgObserver = new IntersectionObserver((entries, obs) => {
        entries.forEach(en => { if (en.isIntersecting) { obs.unobserve(en.target); draw(en.target); } });
    }, { root: scrollParent(box), rootMargin: '400px 0px' });
    box.querySelectorAll('.page').forEach(el => orgObserver.observe(el));

    orgCleanup = () => { try { if (task) task.destroy(); } catch (e) {} };
}

/** Re-mark positions and turns without redrawing any canvas. */
function syncOrganize() {
    const box = $('pages');
    if (!box) return;
    box.querySelectorAll('.page').forEach(el => {
        const o = S.order[Number(el.dataset.idx)];
        if (!o) return;
        const n = el.querySelector('.page-n'); if (n) n.textContent = Number(el.dataset.idx) + 1;
        const s = el.querySelector('.page-src'); if (s) s.textContent = 'was ' + o.p;
        const art = el.querySelector('canvas, img');
        if (art) art.style.transform = o.r ? `rotate(${o.r}deg)` : '';
        el.classList.toggle('turned', !!(o.r % 180));
    });
    render();
}

function orgDirty() { $('result').innerHTML = ''; $('prog').style.display = 'none'; }

window.pjOrgMove = function (from, to) {
    if (from === to || from < 0 || from >= S.order.length) return;
    to = Math.max(0, Math.min(S.order.length - 1, to));
    S.order.splice(to, 0, S.order.splice(from, 1)[0]);
    orgDirty(); organizeGrid(); render();
};
window.pjOrgRotate = function (i, d) {
    const o = S.order[i]; if (!o) return;
    o.r = ((o.r + d) % 360 + 360) % 360;
    orgDirty(); syncOrganize();
};
window.pjOrgDelete = function (i) {
    if (!S.order[i]) return;
    if (S.order.length === 1) { toast('That is the only page left', 'err'); return; }
    S.order.splice(i, 1);
    orgDirty(); organizeGrid(); render();
};
window.pjOrgDuplicate = function (i) {
    const o = S.order[i]; if (!o) return;
    S.order.splice(i + 1, 0, { p: o.p, r: o.r });
    orgDirty(); organizeGrid(); render();
};
window.pjOrgReverse = function () { S.order.reverse(); orgDirty(); organizeGrid(); render(); };
window.pjOrgRotateAll = function (d) {
    S.order.forEach(o => { o.r = ((o.r + d) % 360 + 360) % 360; });
    orgDirty(); syncOrganize();
};
window.pjOrgReset = function () { S.orderFor = ''; ensureOrder(); orgDirty(); organizeGrid(); render(); };

// ── Dragging ───────────────────────────────────────────────────────────────
// The arrow buttons are not a fallback nobody uses: dragging tile 3 to position
// 47 across a scrolling grid is genuinely awkward, and on a long file they win.
let orgFrom = null;

window.pjOrgDragStart = function (ev, i) {
    orgFrom = i;
    ev.dataTransfer.effectAllowed = 'move';
    try { ev.dataTransfer.setData('text/plain', String(i)); } catch (e) {}  // Firefox needs data set
    ev.currentTarget.classList.add('dragging');
};
window.pjOrgDragEnd = function (ev) {
    orgFrom = null;
    ev.currentTarget.classList.remove('dragging');
    document.querySelectorAll('#pages .page.over').forEach(el => el.classList.remove('over'));
};
window.pjOrgDragOver = function (ev, i) {
    if (orgFrom === null) return;
    ev.preventDefault();                        // without this, drop never fires
    ev.dataTransfer.dropEffect = 'move';
    const el = ev.currentTarget;
    if (!el.classList.contains('over') && i !== orgFrom) {
        document.querySelectorAll('#pages .page.over').forEach(x => x.classList.remove('over'));
        el.classList.add('over');
    }
};
window.pjOrgDrop = function (ev, i) {
    ev.preventDefault(); ev.stopPropagation();
    const from = orgFrom !== null ? orgFrom : parseInt(ev.dataTransfer.getData('text/plain'), 10);
    orgFrom = null;
    document.querySelectorAll('#pages .page.over').forEach(el => el.classList.remove('over'));
    if (!isNaN(from)) window.pjOrgMove(from, i);
};

/**
 * Turn the thumbnails to show what Rotate is about to do. Purely visual — a CSS
 * transform on the drawn page, cleared when you leave the tool. Only the pages
 * that will actually turn are turned, which is the same rule the tool follows.
 */
function applyRotationPreview() {
    const box = $('pages');
    if (!box) return;
    const on = S.tool === 'rotate';
    box.querySelectorAll('.page').forEach(el => {
        const art = el.querySelector('canvas, img');
        if (!art) return;
        const n = Number(el.dataset.p);
        const angle = (on && (!S.selected.size || S.selected.has(n))) ? S.angle : 0;
        if (!angle) { art.style.transform = ''; return; }
        // A quarter turn swaps width and height, so it is scaled back to fit a
        // tile that did not change shape. A half turn keeps the same box.
        let fit = 1;
        if (angle === 90 || angle === 270) {
            const w = art.clientWidth || art.width, h = art.clientHeight || art.height;
            if (w && h) fit = Math.min(w / h, h / w);
        }
        art.style.transform = `rotate(${angle}deg) scale(${fit})`;
    });
}

function paintPageModes() {
    const pickable = S.tool === 'split' || S.tool === 'rotate' || S.tool === 'tojpg';
    const dropMode = S.tool === 'split' && S.splitMode === 'remove';
    $('pages').querySelectorAll('.page').forEach(el => {
        el.classList.toggle('pick', pickable);
        el.classList.toggle('drop-mode', dropMode);
        el.classList.toggle('sel', S.selected.has(+el.dataset.p));
        el.onclick = pickable ? () => { const p = +el.dataset.p;
            S.selected.has(p) ? S.selected.delete(p) : S.selected.add(p);
            paintPageModes(); render(); } : null;
    });
    applyRotationPreview();
}

// ═══ Options ════════════════════════════════════════════════════════════════
const radio = (on, t, d, click) =>
    `<div class="radio ${on ? 'on' : ''}" onclick="${click}"><div class="radio-dot"></div>
     <div><div class="radio-t">${t}</div><div class="radio-d">${d}</div></div></div>`;

function paintOptions() {
    const P = E().PRESETS;
    let h = '';
    switch (S.tool) {
        case 'compress':
            h = `<div class="opt-grid">` + Object.keys(P).map(k =>
                radio(S.preset === k, esc(P[k].label), esc(P[k].note || ''), `pjSet('preset','${k}')`)).join('') + `</div>`;
            break;
        case 'ocr':
            h = `<div class="opt-grid">
                ${radio(S.ocrOut === 'pdf', 'Searchable PDF', 'Your scan, untouched, with the text laid over it invisibly. Looks identical; Ctrl-F now finds things.', `pjSet('ocrOut','pdf')`)}
                ${radio(S.ocrOut === 'word', 'Word document', 'The recognised words as an editable .docx. The scan itself is not carried over.', `pjSet('ocrOut','word')`)}
                ${radio(S.ocrOut === 'excel', 'Excel sheet', 'The words laid back into a grid — worth trying when the scan is a table.', `pjSet('ocrOut','excel')`)}
                ${radio(S.ocrOut === 'text', 'Plain text', 'Just the words, as a .txt file.', `pjSet('ocrOut','text')`)}
              </div>
              <div class="blurb" style="margin:14px 0 0">English. The engine and its model are about 18 MB and load once, the first time you run this.</div>`;
            break;
        case 'split':
            h = `<div class="opt-grid">
                ${radio(S.splitMode === 'extract', 'Keep these pages', 'Pick pages on the grid, or type a range below.', `pjSet('splitMode','extract')`)}
                ${radio(S.splitMode === 'remove', 'Drop these pages', 'Everything except what you pick.', `pjSet('splitMode','remove')`)}
                ${radio(S.splitMode === 'each', 'One file per page', 'Delivered as a zip.', `pjSet('splitMode','each')`)}
                ${radio(S.splitMode === 'every', 'Every N pages', 'Break into equal chunks.', `pjSet('splitMode','every')`)}
              </div>`;
            if (S.splitMode === 'extract' || S.splitMode === 'remove')
                h += `<div class="field" style="margin-top:13px"><label for="spec">Pages</label>
                    <input class="input" id="spec" placeholder="e.g. 1-3, 7, 12-" value="${esc(specFromSelection())}"
                    oninput="pjSpecTyped(this.value)"></div>`;
            if (S.splitMode === 'every')
                h += `<div class="field" style="margin-top:13px"><label for="everyN">Pages per file</label>
                    <input class="input" type="number" min="1" id="everyN" value="${S.everyN}"
                    oninput="pjSet('everyN', Math.max(1, +this.value||1))"></div>`;
            break;
        case 'organize': {
            ensureOrder();
            const before = S.files[0] ? (S.files[0].pageCount || 0) : 0;
            const now = S.order.length;
            const turned = S.order.filter(o => o.r).length;
            const moved = orderChanged();
            h = `<div class="blurb" style="margin:0 0 14px">
                    <strong>Drag any page</strong> to move it. Each page also has its own controls —
                    nudge it one place, turn it, duplicate it or remove it — which is usually quicker
                    than dragging across a long file.
                 </div>
                 <div class="opt-row" style="display:flex;gap:8px;flex-wrap:wrap">
                    <button class="btn-ghost" onclick="pjOrgRotateAll(90)">Turn all right</button>
                    <button class="btn-ghost" onclick="pjOrgRotateAll(-90)">Turn all left</button>
                    <button class="btn-ghost" onclick="pjOrgReverse()">Reverse order</button>
                    <button class="btn-ghost" onclick="pjOrgReset()" ${moved ? '' : 'disabled'}>Start again</button>
                 </div>
                 <div class="blurb" style="margin:14px 0 0">${moved
                    ? `<strong>${now} page${now === 1 ? '' : 's'}</strong> in the new order`
                      + (now !== before ? ` (was ${before})` : '')
                      + (turned ? `, ${turned} turned` : '') + '.'
                    : `<strong>${before} page${before === 1 ? '' : 's'}</strong>, still in their original
                       order — nothing changed yet.`}
                    Nothing is written until you press the button.</div>`;
            break;
        }
        case 'rotate':
            // The pages themselves show the answer, so the labels only have to
            // name a direction. "90° right" is precise and still makes people
            // work it out; a curved arrow is understood without reading.
            h = `<div class="opt-grid">
                ${radio(S.angle === 90, '↻&nbsp; Turn right', 'A quarter turn clockwise — the usual fix for a page the scanner fed in sideways.', `pjSet('angle',90)`)}
                ${radio(S.angle === 270, '↺&nbsp; Turn left', 'A quarter turn the other way.', `pjSet('angle',270)`)}
                ${radio(S.angle === 180, '↕&nbsp; Flip upside down', 'A half turn, for a page that came out back to front.', `pjSet('angle',180)`)}
              </div>
              <div class="blurb" style="margin:14px 0 0">
                <strong style="color:var(--tool)">The pages are showing what you will get.</strong>
                ${S.selected.size
                  ? ` Turning the ${S.selected.size} page${S.selected.size === 1 ? '' : 's'} you picked.`
                  : ' Nothing picked, so every page turns. Click pages to turn only some.'}
              </div>`;
            break;
        case 'numbers':
            h = `<div class="field"><label for="numPos">Position</label>
                <select class="input" id="numPos" onchange="pjNum('position',this.value)">
                ${['bottom-centre', 'bottom-right', 'bottom-left', 'top-centre', 'top-right', 'top-left']
                    .map(p => `<option value="${p}" ${S.num.position === p ? 'selected' : ''}>${p.replace('-', ' ')}</option>`).join('')}
                </select></div>
                <div class="field"><label for="numFmt">Format</label>
                <input class="input" id="numFmt" value="${esc(S.num.format)}" oninput="pjNum('format',this.value)"
                    placeholder="{n} or Page {n} of {total}"></div>
                <div class="field"><label for="numStart">Start numbering at</label>
                <input class="input" type="number" id="numStart" value="${S.num.start}" oninput="pjNum('start',+this.value||1)"></div>
                <div class="field"><label for="numSize">Size — ${S.num.size}pt</label>
                <input class="range" type="range" min="7" max="20" id="numSize" value="${S.num.size}"
                    oninput="pjNum('size',+this.value)"></div>`;
            break;
        case 'watermark':
            h = `<div class="field"><label for="wmText">Text</label>
                <input class="input" id="wmText" value="${esc(S.wm.text)}" oninput="pjWm('text',this.value)"></div>
                <div class="field"><label>Opacity — ${S.wm.opacity}%</label>
                <input class="range" type="range" min="3" max="60" value="${S.wm.opacity}" oninput="pjWm('opacity',+this.value)"></div>
                <div class="field"><label>Angle — ${S.wm.angle}°</label>
                <input class="range" type="range" min="0" max="90" value="${S.wm.angle}" oninput="pjWm('angle',+this.value)"></div>`;
            break;
        case 'tojpg':
            h = `<div class="opt-grid">
                ${radio(S.dpi === 96, '96 DPI', 'Small files, screen only.', `pjSet('dpi',96)`)}
                ${radio(S.dpi === 150, '150 DPI', 'Reads well on screen. A good default.', `pjSet('dpi',150)`)}
                ${radio(S.dpi === 300, '300 DPI', 'Print quality. Much larger files.', `pjSet('dpi',300)`)}
              </div>`;
            break;
        case 'fromjpg':
            h = `<div class="opt-grid">
                ${radio(S.fit === 'a4', 'Centre on A4', 'Every image on a standard A4 sheet.', `pjSet('fit','a4')`)}
                ${radio(S.fit === 'fit', 'Page per picture', 'Each page takes the shape of its image.', `pjSet('fit','fit')`)}
              </div>`;
            break;
    }
    $('options').innerHTML = h;
}

window.pjSet = function (k, v) { S[k] = v; if (k === 'splitMode') S.selected.clear(); render(); paintPageModes(); applyRotationPreview(); };
window.pjNum = function (k, v) { S.num[k] = v; render(); };
window.pjWm  = function (k, v) { S.wm[k] = v; render(); };
window.pjSpecTyped = function (v) {
    const list = E().parsePageSpec(v, S.files[0] ? S.files[0].pageCount : 0);
    S.selected = new Set(list || []);
    paintPageModes();
};
function specFromSelection() {
    const p = [...S.selected].sort((a, b) => a - b);
    if (!p.length) return '';
    const out = []; let a = p[0], b = p[0];
    for (let i = 1; i <= p.length; i++) {
        if (p[i] === b + 1) { b = p[i]; continue; }
        out.push(a === b ? String(a) : `${a}-${b}`); a = b = p[i];
    }
    return out.join(', ');
}

// ═══ Render ═════════════════════════════════════════════════════════════════
function render() {
    if (!S.tool) return;
    const t = TOOLS[S.tool];
    const loaded = S.files.length > 0;

    $('blurb').textContent = t.blurb;
    $('dropMain').textContent = !loaded
        ? (t.multi ? 'Drop files here, or click to choose' : 'Drop a file here, or click to choose')
        : (t.multi ? 'Add more' : 'Replace this file');
    $('dropSub').textContent = !loaded ? 'It stays on this computer'
        : (t.multi ? 'They are used in the order listed' : 'Dropping another replaces the one above');
    $('drop').classList.toggle('compact', loaded);

    $('files').innerHTML = S.files.map((f, i) => `<div class="file">
        <span class="file-ico">${t.icon}</span>
        <span class="file-name">${esc(f.name)}</span>
        <span class="file-meta">${fmtSize(f.size)}${f.pageCount ? ' · ' + f.pageCount + 'p' : ''}</span>
        <button class="file-x" onclick="pjRemove(${i})" aria-label="Remove">×</button></div>`).join('');

    const total = S.files.reduce((s, f) => s + f.size, 0);
    const pages = S.files.reduce((s, f) => s + (f.pageCount || 0), 0);
    $('wsMeta').textContent = loaded
        ? `${S.files.length} file${S.files.length === 1 ? '' : 's'}${pages ? ' · ' + pages + ' pages' : ''} · ${fmtSize(total)}`
        : '';

    paintOptions();
    // Split's two page-picking modes cannot run without a selection, and an
    // enabled button whose only possible outcome is an error message is worse
    // than a disabled one that says what it is waiting for.
    const needPages = S.tool === 'split' && (S.splitMode === 'extract' || S.splitMode === 'remove')
        && !S.selected.size;
    $('runBtn').style.display = loaded ? '' : 'none';
    $('clearBtn').style.display = loaded ? '' : 'none';
    $('runBtn').textContent = S.busy ? 'Working…'
        : needPages ? 'Pick pages first' : runLabel();
    $('runBtn').disabled = S.busy || needPages;
}

function runLabel() {
    return { ocr: 'Run OCR', compress: 'Compress', merge: 'Merge', split: 'Split',
        organize: 'Save new order',
        rotate: 'Rotate', numbers: 'Add numbers', watermark: 'Add watermark',
        tojpg: 'Convert to JPG', fromjpg: 'Build PDF', toword: 'Convert to Word',
        toexcel: 'Convert to Excel' }[S.tool] || 'Run';
}

function progress(f, m) {
    $('prog').style.display = '';
    if (f != null) $('progFill').style.width = Math.round(f * 100) + '%';
    if (m) $('progLabel').textContent = m;
}

// A filename shortened for a button, not for a filesystem. Cut from the middle
// so the extension survives — the end of a name says what the file IS, and
// "..._compressed.pdf" is the part someone is checking for. The download
// attribute and the tooltip both still carry the real name in full.
function shortName(n, max) {
    n = String(n || '');
    max = max || 30;
    if (n.length <= max) return n;
    const dot = n.lastIndexOf('.');
    const ext = dot > 0 && n.length - dot <= 6 ? n.slice(dot) : '';
    const stem = ext ? n.slice(0, dot) : n;
    const keep = max - ext.length - 1;
    if (keep < 8) return n.slice(0, max - 1) + '…';
    const head = Math.ceil(keep * 0.6), tail = keep - head;
    return stem.slice(0, head) + '…' + (tail > 0 ? stem.slice(-tail) : '') + ext;
}

function offer(blob, filename, html, cls) {
    if (S.lastUrl) URL.revokeObjectURL(S.lastUrl);
    S.lastUrl = URL.createObjectURL(blob);
    $('prog').style.display = 'none';
    $('result').innerHTML = `<div class="result ${cls || 'good'}">${html}
        <a class="btn btn-primary" href="${S.lastUrl}" download="${esc(filename)}"
           title="${esc(filename)}">↓ Download ${esc(shortName(filename))}</a></div>`;
}

const head = (big, pill) => `<div class="result-head"><span class="result-big">${big}</span>
    ${pill ? `<span class="result-pill">${pill}</span>` : ''}</div>`;
const msg = m => `<div class="result-msg">${m}</div>`;

// ═══ Runners ════════════════════════════════════════════════════════════════
const RUN = {
    async compress() {
        const f = S.files[0];
        const r = await E().compress(f.bytes, { preset: S.preset }, progress);
        if (r.unchanged) {
            $('prog').style.display = 'none';
            $('result').innerHTML = `<div class="result warn">${head(fmtSize(r.original), 'no gain')}
                ${msg('Every setting tried came out <strong>larger</strong> than the file you have — which is what happens once a file has already been squeezed. Nothing was changed.')}</div>`;
            return;
        }
        offer(new Blob([r.bytes], { type: 'application/pdf' }),
            f.name.replace(/\.pdf$/i, '') + '_compressed.pdf',
            head(fmtSize(r.size), '−' + E().pct(r.original, r.size) + '%') +
            msg(`Down from ${fmtSize(r.original)}. Text stayed text — the result is still selectable and searchable.`));
    },
    async merge() {
        const r = await E().merge(S.files, progress);
        const total = S.files.reduce((s, f) => s + f.size, 0);
        offer(new Blob([r.bytes], { type: 'application/pdf' }), 'merged.pdf',
            head(r.pages + ' pages', 'from ' + S.files.length + ' files') +
            msg(`${fmtSize(total)} in, ${fmtSize(r.bytes.length)} out. Every page copied across as it was.`));
    },
    async split() {
        const f = S.files[0];
        const r = await E().split(f.bytes, S.splitMode, {
            spec: $('spec') ? $('spec').value : '', everyN: S.everyN, stem: f.name,
            pages: [...S.selected].sort((a, b) => a - b)
        }, progress);
        if (r.entries) {
            const zip = E().makeZip(r.entries);
            offer(zip, f.name.replace(/\.pdf$/i, '') + '_split.zip',
                head(r.count + ' files', fmtSize(zip.size)) +
                msg(r.entries.map(e => esc(e.name)).slice(0, 6).join(', ') +
                    (r.entries.length > 6 ? ` and ${r.entries.length - 6} more` : '')));
        } else {
            offer(new Blob([r.bytes], { type: 'application/pdf' }), r.name,
                head(r.pages + ' pages', fmtSize(r.bytes.length)) +
                msg(`Taken from ${esc(f.name)} — the original on your computer is untouched.`));
        }
    },
    async organize() {
        const f = S.files[0];
        ensureOrder();
        const before = f.pageCount || 0;
        const distinct = new Set(S.order.map(o => o.p)).size;
        const removed = Math.max(0, before - distinct);
        const added = Math.max(0, S.order.length - distinct);
        const turned = S.order.filter(o => o.r).length;

        progress(0.3, 'Rebuilding the document');
        const r = await E().organisePages(f.bytes, S.order);

        const bits = [];
        if (removed) bits.push(`${removed} removed`);
        if (added) bits.push(`${added} duplicated`);
        if (turned) bits.push(`${turned} turned`);
        offer(new Blob([r.bytes], { type: 'application/pdf' }), f.name.replace(/\.pdf$/i, '') + '_organized.pdf',
            head(r.pages + ' page' + (r.pages === 1 ? '' : 's'), 'reordered') +
            msg(`Saved in the order you arranged${bits.length ? ' — ' + bits.join(', ') : ''}. `
                + `Pages were copied across untouched, never re-rendered, so this is completely lossless.`));
    },
    async rotate() {
        const f = S.files[0];
        const r = await E().rotatePages(f.bytes, { angle: S.angle, pages: [...S.selected] });
        offer(new Blob([r.bytes], { type: 'application/pdf' }), f.name.replace(/\.pdf$/i, '') + '_rotated.pdf',
            head(r.pages + ' pages turned', S.angle + '°') +
            msg('Only the rotation flag moved — not a pixel was re-encoded.'));
    },
    async numbers() {
        const f = S.files[0];
        const r = await E().numberPages(f.bytes, S.num, progress);
        offer(new Blob([r.bytes], { type: 'application/pdf' }), f.name.replace(/\.pdf$/i, '') + '_numbered.pdf',
            head(r.pages + ' pages stamped') + msg('Drawn as real text, so it stays crisp at any zoom.'));
    },
    async watermark() {
        const f = S.files[0];
        const r = await E().watermarkPdf(f.bytes, S.wm, progress);
        offer(new Blob([r.bytes], { type: 'application/pdf' }), f.name.replace(/\.pdf$/i, '') + '_watermarked.pdf',
            head(r.pages + ' pages') + msg(`“${esc(S.wm.text)}” at ${S.wm.opacity}% — real text, nothing underneath is covered.`));
    },
    async tojpg() {
        const f = S.files[0];
        const r = await E().pagesToImages(f.bytes, { dpi: S.dpi, stem: f.name, pages: [...S.selected] }, progress);
        const zip = E().makeZip(r.entries);
        offer(zip, f.name.replace(/\.pdf$/i, '') + '_jpg.zip',
            head(r.count + ' images', fmtSize(zip.size)) + msg(`Rendered at ${S.dpi} DPI.`));
    },
    async fromjpg() {
        const r = await E().imagesToPdf(S.files, { fit: S.fit }, progress);
        offer(new Blob([r.bytes], { type: 'application/pdf' }), 'images.pdf',
            head(r.pages + ' pages', fmtSize(r.bytes.length)) +
            msg('JPEGs and PNGs went in untouched — exactly as sharp as they were.'));
    },
    async toword() {
        const f = S.files[0];
        const r = await E().toOffice(f.bytes, 'word', progress);
        offer(r.blob, f.name.replace(/\.pdf$/i, '') + '.docx',
            head(r.pages + ' pages', fmtSize(r.blob.size)) +
            msg(`${r.runs} text runs recovered into an editable Word document.`));
    },
    async toexcel() {
        const f = S.files[0];
        const r = await E().toOffice(f.bytes, 'excel', progress);
        offer(r.blob, f.name.replace(/\.pdf$/i, '') + '.xlsx',
            head(r.rows + ' rows', fmtSize(r.blob.size)) +
            msg(`${r.runs} text runs laid back into a grid across ${r.pages} page${r.pages === 1 ? '' : 's'}. Check the first rows before trusting the shape.`));
    },
    async ocr() {
        const f = S.files[0];
        const stem = f.name.replace(/\.pdf$/i, '');

        // A PDF that already contains text should almost never be OCR'd. OCR
        // throws the real text away, photographs the page and guesses at the
        // picture — on a CONCOR trade notice that already held 194 text runs,
        // it returned 72 words at 30% confidence while PDF to Word returned the
        // actual sentences. The check costs a fraction of a second, and the
        // alternative is someone quietly getting the worse of two answers.
        if (!S.ocrAnyway) {
            let existing = 0;
            try { existing = (await E().extractLayout(f.bytes, null)).runs || 0; }
            catch (e) { existing = 0; }
            if (existing >= 50) {
                $('prog').style.display = 'none';
                $('result').innerHTML = `<div class="result warn">
                    ${head('Already has text', 'no OCR needed')}
                    ${msg(`This PDF is not purely a scan — it already contains
                     <strong>${existing} pieces of real text</strong>. Converting that directly is
                     exact. OCR would ignore it, take a picture of the page and guess at the
                     letters, which on a file like this is reliably worse.`)}
                    <button class="btn btn-primary" onclick="pjOcrUseText()">Convert to Word instead</button>
                    <button class="btn btn-ghost btn-sm" style="width:100%;margin-top:8px"
                        onclick="pjOcrAnyway()">Run OCR anyway</button>
                </div>`;
                return;
            }
        }
        S.ocrAnyway = false;
        const conf = c => c >= 80 ? 'good' : c >= 60 ? 'warn' : 'bad';
        const note = c => c >= 80
            ? 'A high confidence score — this scan read cleanly.'
            : c >= 60
            ? 'A middling confidence score. Worth reading over before you rely on it.'
            : 'A low confidence score. This scan is faint, skewed or noisy — treat the text as a starting point, not a record.';

        if (S.ocrOut === 'pdf') {
            const r = await window.PdfOcr.searchablePdf(f.bytes, {}, progress);
            offer(new Blob([r.bytes], { type: 'application/pdf' }), stem + '_searchable.pdf',
                head(r.pages + ' pages', r.confidence + '% confident') +
                msg(`Your scan is unchanged — it still looks exactly as it did. The words are now
                     laid over it invisibly, so Ctrl-F finds them and text can be selected and copied.
                     ${note(r.confidence)}`), conf(r.confidence));
            return;
        }

        const r = await window.PdfOcr.readPdf(f.bytes, {}, progress);
        if (!r.runs) throw new Error('No words could be read from this scan. It may be blank, ' +
            'far too faint, or a photograph rather than a document.');

        if (S.ocrOut === 'text') {
            offer(new Blob([r.text], { type: 'text/plain' }), stem + '.txt',
                head(r.runs + ' words', r.confidence + '% confident') + msg(note(r.confidence)));
        } else if (S.ocrOut === 'word') {
            offer(E().buildDocx({ pages: r.pages, runs: r.runs }), stem + '.docx',
                head(r.runs + ' words', r.confidence + '% confident') +
                msg(`Read off ${r.pages.length} page${r.pages.length === 1 ? '' : 's'} into an editable document. ${note(r.confidence)}`));
        } else {
            const x = E().buildXlsx({ pages: r.pages, runs: r.runs });
            offer(x.blob, stem + '.xlsx',
                head(x.rows + ' rows', r.confidence + '% confident') +
                msg(`Columns were inferred from where the words sit on the scan. ${note(r.confidence)}`));
        }
    }
};

// Offered when OCR is asked for on a file that already contains text.
window.pjOcrUseText = function () { S.ocrAnyway = false; pjOpenWith('toword'); };
window.pjOcrAnyway  = function () { S.ocrAnyway = true; pjRun(); };

// Switch tool but keep the file already loaded, then run it — the whole point
// is that the person does not have to find and drop the same file again.
function pjOpenWith(tool) {
    const files = S.files.slice();
    pjOpen(tool);
    S.files = files;
    render();
    pjRun();
}

window.pjRun = async function () {
    if (S.busy || !S.files.length) return;
    S.busy = true; render();
    $('result').innerHTML = '';
    progress(0.02, 'Starting');
    try {
        await RUN[S.tool]();
        if (window.PjAuth) window.PjAuth.logUse(S.tool);
        // Only ever after something actually worked, and at most once.
        if (window.PjSurvey) window.PjSurvey.maybeAsk(S.tool);
    } catch (e) {
        console.error('[paperjet]', e);
        S.lastDiag = diagnostics(e);
        $('prog').style.display = 'none';
        $('result').innerHTML = `<div class="result bad">${head("Couldn't finish", 'error')}
            ${msg(esc(e.message || String(e)))}
            <details class="diag"><summary>Technical details</summary>
                <pre>${esc(S.lastDiag)}</pre>
                <button class="btn btn-sm" style="margin-top:8px" onclick="pjCopyDiag()">Copy details</button>
            </details></div>`;
    } finally {
        S.busy = false; render();
    }
};

function diagnostics(e) {
    const f = S.files[0];
    const lines = [
        'tool      : ' + S.tool,
        'error     : ' + ((e && e.name) || 'Error') + ': ' + ((e && e.message) || String(e)),
        'file      : ' + (f ? `${f.name} · ${fmtSize(f.size)} · ${f.pageCount || '?'} pages` : '(none)'),
        'files     : ' + S.files.length,
        'settings  : preset=' + S.preset + ' split=' + S.splitMode + ' angle=' + S.angle +
                     ' dpi=' + S.dpi + ' ocr=' + S.ocrOut,
        'browser   : ' + navigator.userAgent,
        'build     : ' + BUILD
    ];
    const stack = (e && e.stack ? String(e.stack) : '').split('\n').map(s => s.trim()).filter(Boolean).slice(0, 12);
    return lines.join('\n') + (stack.length ? '\n\nstack:\n  ' + stack.join('\n  ') : '');
}

window.pjCopyDiag = function () {
    const text = S.lastDiag; if (!text) return;
    const done = () => toast('Details copied', 'ok');
    if (navigator.clipboard && navigator.clipboard.writeText)
        navigator.clipboard.writeText(text).then(done, () => legacyCopy(text, done));
    else legacyCopy(text, done);
};
function legacyCopy(text, done) {
    const ta = document.createElement('textarea');
    ta.value = text; ta.style.cssText = 'position:fixed;top:-1000px;opacity:0';
    document.body.appendChild(ta); ta.select();
    try { document.execCommand('copy'); done(); } catch (e) {}
    ta.remove();
}

// ═══ Toast ══════════════════════════════════════════════════════════════════
let toastT = null;
function toast(m, kind) {
    const el = $('toast');
    el.textContent = m;
    el.className = 'toast on ' + (kind || '');
    clearTimeout(toastT);
    toastT = setTimeout(() => { el.className = 'toast ' + (kind || ''); }, 4200);
}
window.pjToast = toast;

window.pjPrivacy = function () {
    alert('PaperJET privacy, in short:\n\n' +
        '· Your documents are never uploaded. Every tool runs inside your browser, ' +
        'so there is nowhere for us to store them even if we wanted to.\n\n' +
        '· If you create an account we store your email address, so you can sign in ' +
        'and so we can send occasional product updates. Nothing else.\n\n' +
        '· We record which tool was used and when — never the file, its name or its contents.\n\n' +
        '· Ask us to delete your account and everything attached to it goes.');
};

// ═══ Wiring ═════════════════════════════════════════════════════════════════
function wire() {
    const drop = $('drop'), input = $('fileInput');
    drop.addEventListener('click', () => input.click());
    drop.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); input.click(); } });
    input.addEventListener('change', () => { addFiles(input.files); input.value = ''; });

    ['dragenter', 'dragover'].forEach(ev => drop.addEventListener(ev, e => {
        e.preventDefault(); e.stopPropagation(); drop.classList.add('over');
    }));
    ['dragleave', 'drop'].forEach(ev => drop.addEventListener(ev, e => {
        e.preventDefault(); e.stopPropagation();
        if (ev === 'dragleave' && drop.contains(e.relatedTarget)) return;
        drop.classList.remove('over');
    }));
    drop.addEventListener('drop', e => addFiles(e.dataTransfer.files));

    // A file dropped anywhere on the page lands in the open tool, rather than
    // being opened by the browser over the top of the app.
    window.addEventListener('dragover', e => e.preventDefault());
    window.addEventListener('drop', e => {
        e.preventDefault();
        if (S.tool && e.dataTransfer && e.dataTransfer.files.length) addFiles(e.dataTransfer.files);
    });

    paintHome();
}

document.addEventListener('DOMContentLoaded', wire);
if (document.readyState !== 'loading') wire();

})();
