/** Escaped HTML. Interpolated strings are escaped; interpolated `Html` values and arrays of them are not. */
export class Html {
  constructor(readonly value: string) {}
  toString() {
    return this.value;
  }
}

const ESCAPES: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
const escape = (value: string) => value.replace(/[&<>"']/g, (c) => ESCAPES[c]!);

type Part = Html | string | number | null | undefined | false | Part[];

function render(part: Part): string {
  if (part === null || part === undefined || part === false) return "";
  if (Array.isArray(part)) return part.map(render).join("");
  if (part instanceof Html) return part.value;
  return escape(String(part));
}

export function html(strings: TemplateStringsArray, ...parts: Part[]): Html {
  return new Html(strings.reduce((out, s, i) => out + s + (i < parts.length ? render(parts[i]!) : ""), ""));
}

export type SiteInfo = {
  publicUrl: string;
  operator: string;
  maxMachines: number;
  retentionDays: number;
  trialDays: number;
  priceLabel: string | null;
  portalUrl: string | null;
};

const STYLE = `
:root { --bg: #fbfaf8; --fg: #1d1c1a; --muted: #6b6760; --line: #e3e0da; --card: #ffffff; --accent: #2f5d50;
  --accent-fg: #ffffff; --warn: #8a4b0f; --code: #f1efe9; color-scheme: light; }
@media (prefers-color-scheme: dark) {
  :root { --bg: #151514; --fg: #ecebe7; --muted: #a29e96; --line: #2d2c29; --card: #1c1c1a; --accent: #7fb8a6;
    --accent-fg: #0f1a17; --warn: #e2a765; --code: #25241f; color-scheme: dark; }
}
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--fg); font: 16px/1.55 system-ui, -apple-system, "Segoe UI", sans-serif; }
main { max-width: 42rem; margin: 0 auto; padding: 3rem 1rem 4rem; }
header { display: flex; justify-content: space-between; align-items: baseline; gap: 1rem; margin-bottom: 2.5rem; }
header a { color: var(--fg); text-decoration: none; font-weight: 600; }
nav a { color: var(--muted); margin-left: 1rem; font-size: .95rem; }
h1 { font-size: 1.9rem; line-height: 1.2; margin: 0 0 .75rem; letter-spacing: -.01em; }
h2 { font-size: 1.15rem; margin: 2rem 0 .5rem; }
p, li { color: var(--fg); }
.lede { color: var(--muted); font-size: 1.05rem; }
.card { background: var(--card); border: 1px solid var(--line); border-radius: 10px; padding: 1.25rem 1.25rem; margin: 1.5rem 0; }
.card ul { margin: .25rem 0 0; padding-left: 1.2rem; }
.price { font-size: 1.1rem; font-weight: 600; }
.actions { display: flex; flex-wrap: wrap; gap: .75rem; margin-top: 1.25rem; }
button { font: inherit; border-radius: 8px; padding: .65rem 1.1rem; cursor: pointer; border: 1px solid var(--accent); }
button.primary { background: var(--accent); color: var(--accent-fg); }
button.secondary { background: transparent; color: var(--fg); border-color: var(--line); }
code, .secret { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: .92em; }
code { background: var(--code); padding: .1em .35em; border-radius: 4px; }
.secret { display: block; background: var(--code); padding: .75rem; border-radius: 8px; overflow-wrap: anywhere; user-select: all; }
pre { background: var(--code); padding: .75rem; border-radius: 8px; white-space: pre-wrap; overflow-wrap: anywhere; }
pre code { background: none; padding: 0; }
.warn { color: var(--warn); }
.muted { color: var(--muted); font-size: .95rem; }
dl { display: grid; grid-template-columns: max-content 1fr; gap: .4rem 1rem; margin: 0; }
dt { color: var(--muted); }
dd { margin: 0; overflow-wrap: anywhere; }
footer { margin-top: 3rem; color: var(--muted); font-size: .9rem; }
footer a { color: var(--muted); }
`;

function page(title: string, site: SiteInfo, body: Html): Html {
  return html`<!doctype html>
    <html lang="en">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <meta name="referrer" content="no-referrer" />
        <title>${title}</title>
        <style>
          ${new Html(STYLE)}
        </style>
      </head>
      <body>
        <main>
          <header>
            <a href="/">${site.operator}</a>
            <nav>
              <a href="/privacy">Privacy</a>${
                site.portalUrl && html`<a href="${site.portalUrl}">Manage subscription</a>`
              }
            </nav>
          </header>
          ${body}
          <footer>
            Machine Sync for <a href="https://github.com/felipearosr/UsageBar">UsageBar</a>. This server runs the
            open-source <a href="https://github.com/felipearosr/usagebar-sync-server">UsageBar Sync Server</a>; you can
            also host your own.
          </footer>
        </main>
      </body>
    </html>`;
}

const formatDate = (iso: string) =>
  new Date(iso).toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric", timeZone: "UTC" });

export function landingPage(site: SiteInfo): Html {
  return page(
    site.operator,
    site,
    html`<h1>Hosted Machine Sync</h1>
      <p class="lede">
        See the Spend of all your machines in UsageBar, without running a server yourself. Your data is encrypted on
        your machines before it leaves them. This server stores it but can't read it.
      </p>
      <div class="card">
        <div class="price">Personal plan${site.priceLabel && html` · ${site.priceLabel}`}</div>
        <ul>
          <li>One Sync Group</li>
          <li>Up to ${site.maxMachines} Machines</li>
          <li>${site.retentionDays} days of history</li>
          <li>${site.trialDays}-day free trial, no card needed</li>
        </ul>
        <div class="actions">
          <form method="post" action="/checkout">
            <input type="hidden" name="plan" value="trial" />
            <button class="primary" type="submit">Start ${site.trialDays}-day trial</button>
          </form>
          <form method="post" action="/checkout">
            <input type="hidden" name="plan" value="subscribe" />
            <button class="secondary" type="submit">Subscribe now</button>
          </form>
        </div>
      </div>
      <h2>How it works</h2>
      <ol>
        <li>Start a trial or subscribe. Payment is handled by Stripe.</li>
        <li>You get a server URL and an Enrollment Token.</li>
        <li>
          In UsageBar, create a Sync Group with that URL and token. The app creates the group's key on your machine, and
          the key never reaches this site or this server.
        </li>
        <li>Pair your other machines with the Pairing Link the app shows you.</li>
      </ol>
      <p class="muted">
        The token lasts as long as the subscription. A trial lasts ${site.trialDays} days, subscribing extends it, and
        cancelling keeps it working until the end of the period you paid for. After that, your machines can still read
        their data for 30 days.
      </p>`,
  );
}

export function privacyPage(site: SiteInfo): Html {
  return page(
    `Privacy · ${site.operator}`,
    site,
    html`<h1>What this server can and can't see</h1>
      <p class="lede">
        Machine Sync is end-to-end encrypted. Each Machine encrypts its data with a key created on your machines. The
        key is never sent to this site or this server, so we can't read your Spend, and neither can anyone who breaks
        into the server.
      </p>
      <h2>The Sync Server can see</h2>
      <ul>
        <li>group IDs, Machine IDs, and how many Machines a group has;</li>
        <li>
          blob names, which reveal which UTC days each Machine had Spend (the server needs them to delete data older
          than ${site.retentionDays} days);
        </li>
        <li>
          blob sizes (padded to 1 KiB steps), write times, each Machine's last-seen time, and client IP addresses;
        </li>
        <li>
          the Enrollment Token used to create each group, and so the link between a paying customer and a group ID.
        </li>
      </ul>
      <h2>The Sync Server can't see</h2>
      <ul>
        <li>Spend amounts, tokens, providers, models, Machine names, or platforms.</li>
      </ul>
      <h2>Payments</h2>
      <p>
        Stripe processes payments. Stripe collects your email address and payment details; this site never receives your
        card details. This site stores your Stripe customer and subscription IDs, the subscription's status and end
        date, and which Enrollment Token it paid for. It stores only a hash of the token, not the token itself.
      </p>
      <h2>Your Pairing Link</h2>
      <p>
        Anyone holding your Pairing Link can read and write all of your group's data. There's no way to revoke a single
        Machine. If a link leaks, create a new group and pair each Machine again.
      </p>
      <h2>Retention and deletion</h2>
      <ul>
        <li>Daily data older than ${site.retentionDays} days is deleted automatically.</li>
        <li>You can delete a Machine, or the whole group, from UsageBar at any time.</li>
        <li>
          When a subscription ends, writes stop and reads keep working for 30 days so you can move to another server.
        </li>
      </ul>
      <p class="muted">
        This follows section 10 of the
        <a href="https://github.com/felipearosr/UsageBar/blob/main/docs/machine-sync-protocol.md"
          >Machine Sync protocol</a
        >. The server's source code is public.
      </p>`,
  );
}

function setupSteps(site: SiteInfo, token: string | null): Html {
  const tokenArg = token ?? "<your-enrollment-token>";
  return html`<h2>Set up UsageBar</h2>
    <ol>
      <li>In UsageBar, create a Sync Group and enter the server URL and Enrollment Token above.</li>
      <li>Or, from a terminal:</li>
    </ol>
    <pre><code>codexbar sync create --server ${site.publicUrl} --token ${tokenArg}</code></pre>
    <p>Then pair your other machines with the Pairing Link the app prints.</p>`;
}

function reissueForm(sessionId: string, label: string): Html {
  return html`<form method="post" action="/welcome/reissue">
    <input type="hidden" name="session_id" value="${sessionId}" />
    <button class="secondary" type="submit">${label}</button>
  </form>`;
}

export function tokenPage(
  site: SiteInfo,
  args: { token: string; expiresAt: string; replaced: boolean; sessionId: string },
): Html {
  return page(
    `Your Enrollment Token · ${site.operator}`,
    site,
    html`<h1>You're set up</h1>
      ${args.replaced && html`<p class="warn">This token replaces the one shown before. The old one no longer works.</p>`}
      <div class="card">
        <dl>
          <dt>Server URL</dt>
          <dd><code>${site.publicUrl}</code></dd>
          <dt>Expires</dt>
          <dd>${formatDate(args.expiresAt)}</dd>
        </dl>
        <p><strong>Enrollment Token</strong></p>
        <code class="secret">${args.token}</code>
        <p class="warn">This page shows the token once. Copy it now.</p>
      </div>
      ${setupSteps(site, args.token)}
      <p class="muted">
        Lost it before creating your group? Keep this page's address: opening it again lets you replace the token until
        it has been used.
      </p>`,
  );
}

export function existingTokenPage(
  site: SiteInfo,
  args: { expiresAt: string; inUse: boolean; canReissue: boolean; sessionId: string },
): Html {
  const ended = !args.inUse && !args.canReissue;
  const status = args.inUse
    ? html`<p>
        Your Enrollment Token has already created your Sync Group. Pair more machines with the Pairing Link from
        UsageBar (<code>codexbar sync link</code>).
      </p>`
    : ended
      ? html`<p>Your subscription has ended, so the token can no longer create a Sync Group.</p>`
      : html`<p>
          Your Enrollment Token isn't in use by a Sync Group. If you didn't save it when this page first showed it, or
          you deleted your group, replace it. The old token will stop working.
        </p>`;
  return page(
    `Your subscription · ${site.operator}`,
    site,
    html`<h1>Your subscription</h1>
      <div class="card">
        <dl>
          <dt>Server URL</dt>
          <dd><code>${site.publicUrl}</code></dd>
          <dt>Expires</dt>
          <dd>${formatDate(args.expiresAt)}</dd>
        </dl>
        ${status}
        ${args.canReissue && html`<div class="actions">${reissueForm(args.sessionId, "Replace my token")}</div>`}
      </div>`,
  );
}

export function messagePage(site: SiteInfo, title: string, message: string, status?: Html): Html {
  return page(
    `${title} · ${site.operator}`,
    site,
    html`<h1>${title}</h1>
      <p>${message}</p>
      ${status}`,
  );
}
