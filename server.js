// server.js: the roster. For each stylist, how many bookings they have today and this week,
// and a list of today's bookings. It only reads the bookings that bench-bookings shares; it
// stores nothing and nobody edits anything here.
const http = require("node:http");
const { VmnodesIdentity, IdentityError } = require("@vmnodes/identity");
const { queryShared } = require("./query-shared");
const { buildRoster, ranges } = require("./dates");

const APP_NAME = process.env.VMNODES_APP_NAME || "roster";
const VIEWER_ROLE = "roster.viewer"; // must match vmnodes.json exactly
const VERSION = require("./package.json").version;
const BUILD_COMMIT = process.env.BUILD_COMMIT || null;
const PORT = Number(process.env.PORT || 3000);
const LISTEN_ADDRESS = process.env.LISTEN_ADDRESS || undefined;
const TZ = process.env.ROSTER_TZ || "Australia/Sydney";
const ENTITY = "bench-bookings.booking";
const CACHE_MS = Number(process.env.ROSTER_CACHE_MS ?? 30000);

// Where the shared-data API is and the token to call it with. The platform gives an app that only
// reads neither (see the docs), so SHARED_DATA_URL / SHARED_DATA_TOKEN are what an operator would
// supply; VMNODES_API_URL / VMNODES_PUBLISH_TOKEN are used if the platform has set them.
const API_URL = process.env.SHARED_DATA_URL || process.env.VMNODES_API_URL || "";
const API_TOKEN = process.env.SHARED_DATA_TOKEN || process.env.VMNODES_PUBLISH_TOKEN || "";

let identity;
try {
  identity = new VmnodesIdentity();
} catch (err) {
  console.error(`${err.message}\nThe platform sets these when your app is deployed; locally, \`npm run dev\` sets them for you.`);
  process.exit(1);
}

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

function send(res, status, body, type = "application/json") {
  res.writeHead(status, { "content-type": type, "cache-control": "no-store" });
  res.end(type === "application/json" ? JSON.stringify(body) : body);
}

let cache = null; // { at, value } — the same for everyone who may see the roster
async function loadRoster(now = new Date()) {
  if (cache && now.getTime() - cache.at < CACHE_MS) return cache.value;
  let value;
  if (!API_URL || !API_TOKEN) {
    value = { connected: false, reason: "not-configured" };
  } else {
    const r = ranges(now, TZ);
    try {
      const got = await queryShared({
        apiUrl: API_URL,
        token: API_TOKEN,
        entity: ENTITY,
        select: ["startsAt", "service", "stylist"],
        filter: [
          { field: "startsAt", op: "gte", value: r.weekStart.toISOString() },
          { field: "startsAt", op: "lt", value: r.weekEnd.toISOString() },
        ],
        orderBy: { field: "startsAt", dir: "asc" },
        limit: 200,
      });
      value = { connected: true, truncated: got.truncated, asOf: got.provenance?.freshestAt || null, ...buildRoster(got.rows || [], now, TZ) };
    } catch (e) {
      console.error(`reading ${ENTITY} failed: ${e.status || ""} ${e.code || ""} ${e.message}`);
      value = { connected: false, reason: "refused", status: e.status || null, code: e.code || null, message: e.message };
    }
  }
  cache = { at: now.getTime(), value: value.connected ? value : { ...value } };
  return value;
}

function fmtDay(iso, opts) { return new Intl.DateTimeFormat("en-AU", { timeZone: TZ, ...opts }).format(new Date(iso)); }

function page(user, data) {
  let body;
  if (!data.connected) {
    body = data.reason === "refused"
      ? `<div class="note" id="status"><p><strong>The bookings could not be read.</strong></p><p>The platform answered: <code>${esc(data.message)}</code></p><p>This app has not been given access to the <code>${esc(ENTITY)}</code> records yet, so there is no roster to show.</p></div>`
      : `<div class="note" id="status"><p><strong>Shared data is not connected yet.</strong></p><p>This roster reads the <code>${esc(ENTITY)}</code> records that bench-bookings shares. It has not been given access to them yet, so there is no roster to show.</p></div>`;
  } else {
    const rows = data.stylists.map((s) => `<tr><th scope="row">${esc(s.stylist)}</th><td class="n">${s.today}</td><td class="n">${s.week}</td></tr>`).join("");
    const lists = data.stylists.map((s) => {
      const items = s.bookings.length ? s.bookings.map((b) => `<li><span class="t">${esc(b.time)}</span> ${esc(b.service)}</li>`).join("") : "<li>No bookings today.</li>";
      return `<section class="stylist"><h3>${esc(s.stylist)}</h3><ul>${items}</ul></section>`;
    }).join("");
    body = data.stylists.length
      ? `<table id="counts"><thead><tr><th>Stylist</th><th class="n">Today</th><th class="n">This week</th></tr></thead><tbody>${rows}</tbody></table>
<h2>Today's bookings</h2>${lists}`
      : `<p id="status">No bookings this week.</p>`;
    body += (data.truncated ? `<p class="note">There are more bookings this week than this page can read at once, so the counts may be too low.</p>` : "")
      + `<p><small id="asof">Week of ${esc(fmtDay(data.range.weekStart, { day: "numeric", month: "long" }))}, Monday to Sunday, ${esc(TZ)} time. Bookings as of ${data.asOf ? esc(fmtDay(data.asOf, { dateStyle: "medium", timeStyle: "short" })) : "an unknown time"}; a copy, so it can be a little old.</small></p>`;
  }
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Roster</title>
<style>body{font:16px/1.5 system-ui,sans-serif;background:#0b0c10;color:#e8e8ee;max-width:720px;margin:0 auto;padding:16px}table{border-collapse:collapse;width:100%}th,td{text-align:left;padding:8px;border-bottom:1px solid #2a2c35}.n{text-align:right}ul{list-style:none;padding:0;margin:0}li{padding:4px 0;border-bottom:1px solid #2a2c35}.t{font-variant-numeric:tabular-nums;color:#b9b6ff;display:inline-block;min-width:5.5em}small{color:#9a9cab}.note{border:1px solid #2a2c35;border-radius:6px;padding:8px 12px;background:#15161c}code{font-family:ui-monospace,monospace}.stylist{margin-bottom:16px}h3{margin:12px 0 4px}</style></head>
<body><h1>Roster</h1><p id="who"><small>Signed in as <strong>${esc(user.name || user.email)}</strong></small></p>${body}</body></html>`;
}

async function handle(req, res) {
  const url = new URL(req.url, "http://app");
  if (url.pathname === "/health") {
    return send(res, 200, { status: "ok", app: APP_NAME, version: VERSION, buildCommit: BUILD_COMMIT, storage: "none", sharedData: Boolean(API_URL && API_TOKEN) });
  }
  const user = await identity.currentUser(req.headers);
  if (req.method !== "GET") return send(res, 405, { error: "this app is read-only" });
  if (url.pathname === "/api/me") return send(res, 200, user);
  if (url.pathname === "/api/probe") { // TEMPORARY: what can this app's token see?
    identity.requireRole(user, VIEWER_ROLE);
    if (!API_URL || !API_TOKEN) return send(res, 200, { configured: false });
    const r = await fetch(`${API_URL}/v1/data/entities`, { headers: { authorization: `Bearer ${API_TOKEN}` }, signal: AbortSignal.timeout(15000) });
    return send(res, 200, { configured: true, status: r.status, body: await r.text() });
  }
  if (url.pathname === "/" || url.pathname === "/api/roster") {
    identity.requireRole(user, VIEWER_ROLE); // checked on the SERVER
    const data = await loadRoster();
    if (url.pathname === "/api/roster") return send(res, 200, data);
    return send(res, 200, page(user, data), "text/html; charset=utf-8");
  }
  return send(res, 404, { error: "not found" });
}

const server = http.createServer((req, res) => {
  handle(req, res).catch((err) => {
    const status = err instanceof IdentityError ? err.status : 500;
    if (status >= 500) console.error(err.cause || err);
    send(res, status, { error: status === 500 ? "something went wrong" : err.message });
  });
});
server.listen({ port: PORT, host: LISTEN_ADDRESS }, () => console.log(`${APP_NAME} ${VERSION} listening on :${server.address().port}`));
