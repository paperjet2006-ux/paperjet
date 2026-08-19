/* Theme switch. Loaded by every page, including ones that do not load the app,
   so the control in the header works everywhere it appears. */
(function () {
'use strict';

// ═══ Theme ══════════════════════════════════════════════════════════════════
// The choice is remembered and never inferred. A tool someone opens once a
// week should look the way they last left it, rather than following whatever
// their operating system decided that morning. The <html> attribute is set by
// a tiny inline script in <head> so the first paint is already correct; this
// only handles the switch itself.
const THEME_KEY = 'pj.theme';

window.pjTheme = function () {
    const now = document.documentElement.getAttribute('data-theme') === 'light' ? 'dark' : 'light';
    document.documentElement.setAttribute('data-theme', now);
    try { localStorage.setItem(THEME_KEY, now); } catch (e) { /* private mode */ }
    // The address bar and mobile status bar are painted from this.
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute('content', now === 'light' ? '#f4f6fb' : '#05060a');
};

})();
