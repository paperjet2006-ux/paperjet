/* ═══════════════════════════════════════════════════════════════════════════
   MANIFEST PDF — accounts and email capture
   ═══════════════════════════════════════════════════════════════════════════

   Deliberately optional. Every tool on this site works signed out, and nothing
   is gated — an account exists so there is a way to reach people about new
   tools, not as a toll gate. A site whose whole promise is "we never see your
   files" cannot then hold those files hostage behind a signup.

   What is stored: an email address, a hashed password (never the password),
   and one row per tool run — which tool, and when. Never the file, its name,
   its size or anything read out of it. That boundary is worth stating plainly
   because it is the entire reason to trust the rest of the site.

   Written against Supabase's REST endpoints rather than its JS SDK: the SDK is
   another 40 KB of third-party script on a page whose pitch is that it does
   not phone home, and everything needed here is four fetch calls.
   ═════════════════════════════════════════════════════════════════════════ */
(function () {
'use strict';

const CFG = window.PJ_CONFIG || {};
const ON = !!(CFG.supabaseUrl && CFG.supabaseKey);
const KEY = 'pj.session';

let session = null;
try { session = JSON.parse(localStorage.getItem(KEY) || 'null'); } catch (e) { session = null; }

let mode = 'signup';   // signup | signin

const $ = id => document.getElementById(id);

function api(path, opts) {
    return fetch(CFG.supabaseUrl + path, Object.assign({}, opts, {
        headers: Object.assign({
            'apikey': CFG.supabaseKey,
            'Content-Type': 'application/json'
        }, (opts && opts.headers) || {})
    })).then(async r => {
        const body = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(body.msg || body.error_description || body.message || 'That did not work');
        return body;
    });
}

function save(s) {
    session = s;
    if (s) localStorage.setItem(KEY, JSON.stringify(s));
    else localStorage.removeItem(KEY);
    paint();
}

function paint() {
    const btn = $('authBtn');
    if (!btn) return;
    if (!ON) { btn.style.display = 'none'; return; }
    btn.textContent = session ? (session.email || 'Account') : 'Sign in';
    btn.onclick = session ? signOut : window.pjAuthOpen;
}

function signOut() {
    save(null);
    window.pjToast && window.pjToast('Signed out', 'ok');
}

// ── Modal ──────────────────────────────────────────────────────────────────
window.pjAuthOpen = function () {
    if (!ON) { window.pjToast && window.pjToast('Accounts are not switched on yet'); return; }
    setMode('signup');
    $('authModal').classList.add('on');
    setTimeout(() => $('authEmail').focus(), 60);
};
window.pjAuthClose = function () { $('authModal').classList.remove('on'); };
window.pjAuthToggle = function () { setMode(mode === 'signup' ? 'signin' : 'signup'); };

function setMode(m) {
    mode = m;
    const signup = m === 'signup';
    $('authTitle').textContent = signup ? 'Create your account' : 'Welcome back';
    $('authSub').textContent = signup
        ? 'Optional — every tool works without one. An account remembers your settings and gets you new tools as they land.'
        : 'Sign in to pick up where you left off.';
    $('authSubmit').textContent = signup ? 'Create account' : 'Sign in';
    $('authAltText').textContent = signup ? 'Already have an account?' : 'No account yet?';
    $('authAltBtn').textContent = signup ? 'Sign in' : 'Create one';
    $('consentRow').style.display = signup ? '' : 'none';
    $('authPass').autocomplete = signup ? 'new-password' : 'current-password';
}

window.pjAuthSubmit = function (ev) {
    ev.preventDefault();
    const email = $('authEmail').value.trim();
    const pass = $('authPass').value;
    const btn = $('authSubmit');

    if (mode === 'signup' && !$('authConsent').checked) {
        window.pjToast('Please tick the consent box to continue', 'err');
        return false;
    }

    btn.disabled = true;
    btn.textContent = mode === 'signup' ? 'Creating…' : 'Signing in…';

    const path = mode === 'signup' ? '/auth/v1/signup' : '/auth/v1/token?grant_type=password';
    api(path, { method: 'POST', body: JSON.stringify({ email: email, password: pass }) })
        .then(res => {
            // A project with email confirmation on returns a user but no token;
            // saying "check your email" beats a silent no-op.
            if (!res.access_token) {
                window.pjAuthClose();
                window.pjToast('Account created — check your email to confirm it', 'ok');
                return;
            }
            save({ token: res.access_token, refresh: res.refresh_token,
                   email: (res.user && res.user.email) || email,
                   id: res.user && res.user.id });
            window.pjAuthClose();
            window.pjToast(mode === 'signup' ? 'Account created — welcome' : 'Signed in', 'ok');
        })
        .catch(e => window.pjToast(e.message, 'err'))
        .finally(() => { btn.disabled = false; setMode(mode); });

    return false;
};

/**
 * One row per tool run: which tool, and when. Fire-and-forget — a logging
 * failure must never surface as a failed conversion, because the conversion
 * already succeeded and the user does not care about our analytics.
 */
function logUse(tool) {
    if (!ON || !CFG.logUsage) return;
    try {
        api('/rest/v1/tool_runs', {
            method: 'POST',
            headers: Object.assign({ 'Prefer': 'return=minimal' },
                session ? { 'Authorization': 'Bearer ' + session.token } : {}),
            body: JSON.stringify({ tool: tool, user_id: session ? session.id : null })
        }).catch(() => {});
    } catch (e) { /* never block a conversion on this */ }
}

window.PjAuth = { logUse, signOut, get session() { return session; }, enabled: ON };

document.addEventListener('DOMContentLoaded', paint);
if (document.readyState !== 'loading') paint();

})();
