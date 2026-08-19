/* ═══════════════════════════════════════════════════════════════════════════
   MANIFEST PDF — "who are you, and what is this for?"
   ═══════════════════════════════════════════════════════════════════════════

   Asked ONCE per browser, and only after a tool has actually produced
   something. That ordering is the whole design. A survey standing between
   someone and their file is the most reliable way to lose them and to collect
   a mailbox full of asdf@asdf.com; the same survey thirty seconds later, when
   the site has just saved them three megabytes, is a fair thing to ask.

   Two steps, in this order on purpose:

     Step 1 — what do you do, and what do you use this for. No personal data,
              two dropdowns, five seconds. Most people will answer it.
     Step 2 — name, email, company, where you are. Personal data, and the only
              part that needs a consent tick.

   Someone who answers step 1 and closes step 2 still leaves the most valuable
   half of the answer — "customs broker, mostly OCR" tells you what to build
   next, and it needs no email attached to be worth having. So step 1 is banked
   whatever happens afterwards, and the database itself refuses contact details
   unless consent was actually given.

   Nothing here is required and nothing is gated: every tool works, forever,
   for someone who never answers a word of it. The Skip button is real, and
   skipping is remembered as firmly as answering.
   ═════════════════════════════════════════════════════════════════════════ */
(function () {
'use strict';

const CFG = window.PJ_CONFIG || {};
const ON = !!(CFG.supabaseUrl && CFG.supabaseKey && CFG.survey);
const KEY = 'pj.survey.done';

const $ = id => document.getElementById(id);
let step = 1, answers = {}, shown = false;

const INDUSTRIES = [
    'Customs broking / freight forwarding',
    'Import / export business',
    'Logistics & transport',
    'Accounting / audit / tax',
    'Legal',
    'Banking / insurance',
    'Manufacturing',
    'Government / public sector',
    'Education / student',
    'Healthcare',
    'IT / software',
    'Personal use',
    'Something else'
];

const USES = [
    'Shrinking files to fit an upload limit',
    'Reading scanned documents (OCR)',
    'Pulling tables out into Excel',
    'Merging paperwork into one file',
    'Splitting or removing pages',
    'Stamping numbers or watermarks',
    'Converting between PDF and images',
    'A bit of everything'
];

const COUNTRIES = ['India', 'United Arab Emirates', 'Singapore', 'United States',
    'United Kingdom', 'Australia', 'Canada', 'Germany', 'Netherlands', 'Somewhere else'];

function done() { try { return !!localStorage.getItem(KEY); } catch (e) { return true; } }
function markDone(how) { try { localStorage.setItem(KEY, how || 'yes'); } catch (e) {} }

/** Called after any tool produces a result. Fires at most once, ever. */
function maybeAsk(tool) {
    if (!ON || shown || done()) return;
    shown = true;
    answers = { first_tool: tool || null };
    step = 1;
    // A short beat so the dialog does not cover the download button the moment
    // it appears — the file they came for takes priority over our question.
    setTimeout(open, 1400);
}

function open() { paint(); $('svModal').classList.add('on'); }

function close(how) {
    $('svModal').classList.remove('on');
    markDone(how || 'closed');
    // Bank whatever we have. Step 1 on its own is worth keeping.
    send();
}

function paint() {
    const opt = (list, cur) => list.map(v =>
        `<option value="${v.replace(/"/g, '&quot;')}" ${cur === v ? 'selected' : ''}>${v}</option>`).join('');

    $('svBody').innerHTML = step === 1 ? `
        <h2>That worked. Mind a quick question?</h2>
        <p class="sub">Two dropdowns, no typing. It tells us which tool to build next —
           and this site is free, so it is the only thing we ask for.</p>
        <div class="field">
            <label for="svIndustry">What do you do?</label>
            <select class="input" id="svIndustry">
                <option value="">Choose one…</option>${opt(INDUSTRIES, answers.industry)}
            </select>
        </div>
        <div class="field">
            <label for="svUse">What do you mostly use Manifest PDF for?</label>
            <select class="input" id="svUse">
                <option value="">Choose one…</option>${opt(USES, answers.use_case)}
            </select>
        </div>
        <div class="sv-row">
            <button class="btn btn-ghost" onclick="pjSurveySkip()">Skip</button>
            <button class="btn btn-primary" onclick="pjSurveyNext()">Next</button>
        </div>
        <div class="sv-dots"><span class="on"></span><span></span></div>
    ` : `
        <h2>Thanks — that helps.</h2>
        <p class="sub">If you would like to hear when new tools land, leave your details.
           Entirely optional: the answer above is already saved, and nothing here
           unlocks anything.</p>
        <div class="field">
            <label for="svName">Name</label>
            <input class="input" id="svName" autocomplete="name" placeholder="Your name">
        </div>
        <div class="field">
            <label for="svEmail">Email</label>
            <input class="input" type="email" id="svEmail" autocomplete="email" placeholder="you@company.com">
        </div>
        <div class="field">
            <label for="svCompany">Company</label>
            <input class="input" id="svCompany" autocomplete="organization" placeholder="Where you work">
        </div>
        <div class="sv-two">
            <div class="field">
                <label for="svCountry">Country</label>
                <select class="input" id="svCountry"><option value="">—</option>${opt(COUNTRIES, answers.country)}</select>
            </div>
            <div class="field">
                <label for="svCity">City</label>
                <input class="input" id="svCity" placeholder="Optional">
            </div>
        </div>
        <label class="consent">
            <input type="checkbox" id="svConsent">
            <span>Store my details so Manifest PDF can email me about new tools. I can ask for
                  them to be deleted at any time. My documents are never uploaded or stored
                  — see the <a href="/privacy" target="_blank">privacy policy</a>.</span>
        </label>
        <div class="sv-row">
            <button class="btn btn-ghost" onclick="pjSurveySkip()">No thanks</button>
            <button class="btn btn-primary" onclick="pjSurveyFinish()">Done</button>
        </div>
        <div class="sv-dots"><span></span><span class="on"></span></div>
    `;
}

window.pjSurveyNext = function () {
    answers.industry = ($('svIndustry').value || '').trim() || null;
    answers.use_case = ($('svUse').value || '').trim() || null;
    if (!answers.industry && !answers.use_case) {
        window.pjToast && window.pjToast('Pick one, or press Skip', 'err');
        return;
    }
    step = 2;
    paint();
};

window.pjSurveyFinish = function () {
    const consent = $('svConsent').checked;
    const email = ($('svEmail').value || '').trim();
    const name = ($('svName').value || '').trim();
    const company = ($('svCompany').value || '').trim();

    if ((email || name || company) && !consent) {
        window.pjToast && window.pjToast('Please tick the box so we may store those details', 'err');
        return;
    }
    if (consent) {
        answers.consented = true;
        answers.name = name || null;
        answers.email = email || null;
        answers.company = company || null;
    }
    // Country and city are not personal on their own, so they travel either way.
    answers.country = ($('svCountry').value || '').trim() || null;
    answers.city = ($('svCity').value || '').trim() || null;

    $('svModal').classList.remove('on');
    markDone('answered');
    send();
    window.pjToast && window.pjToast('Thank you — that genuinely helps', 'ok');
};

window.pjSurveySkip = function () { close('skipped'); };
window.pjSurveyClose = function () { close('closed'); };

let sent = false;
function send() {
    if (sent || !ON) return;
    if (!answers.industry && !answers.use_case && !answers.email) return;  // nothing worth a row
    sent = true;
    fetch(CFG.supabaseUrl + '/rest/v1/survey_responses', {
        method: 'POST',
        headers: {
            'apikey': CFG.supabaseKey,
            'Content-Type': 'application/json',
            'Prefer': 'return=minimal'
        },
        body: JSON.stringify({
            industry: answers.industry || null,
            use_case: answers.use_case || null,
            first_tool: answers.first_tool || null,
            name: answers.name || null,
            email: answers.email || null,
            company: answers.company || null,
            country: answers.country || null,
            city: answers.city || null,
            consented: !!answers.consented
        })
    }).catch(() => { /* a lost survey row is not the user's problem */ });
}

window.PjSurvey = { maybeAsk, enabled: ON };

})();
