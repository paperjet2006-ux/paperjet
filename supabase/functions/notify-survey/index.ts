/* notify-survey — emails paperjet2006@gmail.com when someone answers the survey.
 *
 * Invoked by a Supabase database webhook on INSERT into survey_responses, so
 * the notification is driven by the row actually landing rather than by the
 * browser reporting that it sent one. A row can only exist if it passed the
 * consent policy, which means an email here always describes a real, consented
 * submission.
 *
 * The Resend key lives in this function's secrets, never in the page. The
 * browser has no part in this and cannot trigger it.
 */

const RESEND_KEY = Deno.env.get('RESEND_API_KEY');
const TO         = Deno.env.get('NOTIFY_TO') ?? 'paperjet2006@gmail.com';

// Resend's shared sender. Works with no domain of your own, but may only
// deliver to the address that owns the Resend account — which is why the
// account must be opened with the same address as TO above. Swap this for
// something like hello@yourdomain once a domain is verified.
const FROM = 'PaperJET <onboarding@resend.dev>';

const esc = (s: unknown) =>
    String(s ?? '').replace(/[&<>"]/g, c =>
        ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!));

/* Only the fields worth reading in a notification, in the order a person would
   want them. A missing value is shown as an em dash rather than omitted, so the
   shape of the email stays the same and a blank is visibly a blank. */
const FIELDS: [string, string][] = [
    ['Name',     'name'],
    ['Email',    'email'],
    ['Company',  'company'],
    ['Industry', 'industry'],
    ['Uses it for', 'use_case'],
    ['First tool',  'first_tool'],
    ['Country',  'country'],
    ['City',     'city'],
];

Deno.serve(async (req) => {
    if (req.method !== 'POST') return new Response('POST only', { status: 405 });

    if (!RESEND_KEY) {
        console.error('RESEND_API_KEY is not set');
        return new Response('misconfigured', { status: 500 });
    }

    let record: Record<string, unknown>;
    try {
        const body = await req.json();
        record = body?.record ?? body;      // webhook shape, or a bare row when testing
    } catch {
        return new Response('bad json', { status: 400 });
    }

    const rows = FIELDS.map(([label, key]) =>
        `<tr>
           <td style="padding:6px 14px 6px 0;color:#6b7280;white-space:nowrap">${label}</td>
           <td style="padding:6px 0;color:#111827"><b>${esc(record[key]) || '—'}</b></td>
         </tr>`).join('');

    const html = `
      <div style="font-family:-apple-system,Segoe UI,Roboto,sans-serif;max-width:520px">
        <h2 style="margin:0 0 4px;font-size:18px;color:#111827">New PaperJET survey response</h2>
        <p style="margin:0 0 18px;color:#6b7280;font-size:13px">
          ${esc(record.created_at ?? new Date().toISOString())}
        </p>
        <table style="border-collapse:collapse;font-size:14px">${rows}</table>
        <p style="margin:20px 0 0;color:#9ca3af;font-size:12px">
          Consent: ${record.consented ? 'given' : 'not given'} · row #${esc(record.id)}
        </p>
      </div>`;

    const subject = record.email
        ? `PaperJET survey — ${record.email}`
        : 'PaperJET survey — anonymous response';

    const res = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${RESEND_KEY}`,
            'Content-Type': 'application/json',
        },
        body: JSON.stringify({ from: FROM, to: [TO], subject, html }),
    });

    if (!res.ok) {
        // Logged rather than thrown: the row is already saved and is the record
        // of truth, so a failed notification must not look like a failed signup.
        const detail = await res.text();
        console.error('resend failed', res.status, detail);
        return new Response(detail, { status: 502 });
    }

    return new Response('sent', { status: 200 });
});
