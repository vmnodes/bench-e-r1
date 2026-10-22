// test/smoke.js: `npm test`. Proves the roster does what the platform needs and what the customer asked:
// sign-in is checked properly, the roster is gated by role, health answers without sign-in, the date
// arithmetic is right at the edges (literal expected values), and the page counts what the shared-data
// API returns. Every "refused" row has a matching "accepted" row.
const { spawn } = require("node:child_process");
const http = require("node:http");
const path = require("node:path");
const { SignJWT, generateKeyPair } = require("jose");
const { startMockPortal } = require("../dev/mock-portal");
const { startMockDataApi } = require("../dev/mock-data-api");
const { buildRoster, ranges } = require("../dates");

const APP_ID = "app_smoke_test";
const TOKEN = "smoke-token";
const SERVER = path.join(__dirname, "..", "server.js");
const children = [];
let pass = 0, fail = 0;
function check(name, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  ok ? pass++ : fail++;
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${ok ? "" : `  (expected ${JSON.stringify(want)}, got ${JSON.stringify(got)})`}`);
}

function startApp(env) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [SERVER], { env: { PATH: process.env.PATH, PORT: "0", LISTEN_ADDRESS: "127.0.0.1", ROSTER_CACHE_MS: "0", ...env }, stdio: ["ignore", "pipe", "pipe"] });
    children.push(child);
    let out = "";
    const onData = (d) => { out += d; const m = out.match(/listening on :(\d+)/); if (m) resolve({ child, url: `http://127.0.0.1:${m[1]}`, out: () => out }); };
    child.stdout.on("data", onData); child.stderr.on("data", onData);
    child.on("exit", (code) => resolve({ child, exited: code, out: () => out }));
  });
}

function request(url, { method = "GET", headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(url, { method, headers }, (res) => {
      let data = ""; res.on("data", (d) => (data += d));
      res.on("end", () => resolve({ status: res.statusCode, body: data, json: () => JSON.parse(data) }));
    });
    req.on("error", reject);
    req.end();
  });
}

// Signs a token the way the gateway does, with a key of our choosing.
async function token(portal, key, { sub, roles, aud = APP_ID, iss = portal.issuer, kid = "local-dev" }) {
  return new SignJWT({ email: "t.local", name: "T", kind: "employee", groups: [], roles })
    .setProtectedHeader({ alg: "RS256", kid }).setSubject(sub).setIssuer(iss).setAudience(aud).setIssuedAt().setExpirationTime("5m").sign(key);
}

(async () => {
  // --- 1. Dates, with literal expectations -----------------------------------------------------
  // Fri 23 Oct 2026, 09:11 Sydney time (AEDT, +11) is still Thu 22 Oct in UTC.
  const now = new Date("2026-10-22T22:11:00Z"), SYD = "Australia/Sydney";
  const r = ranges(now, SYD);
  check("today in Sydney starts at midnight local", [r.todayStart.toISOString(), r.todayEnd.toISOString()], ["2026-10-22T13:00:00.000Z", "2026-10-23T13:00:00.000Z"]);
  check("the week runs Monday to Sunday, local", [r.weekStart.toISOString(), r.weekEnd.toISOString()], ["2026-10-18T13:00:00.000Z", "2026-10-25T13:00:00.000Z"]);
  const dst = ranges(new Date("2026-10-04T01:00:00Z"), SYD); // Sunday 4 Oct: daylight saving starts at 2am, a 23-hour day
  check("a daylight-saving day is 23 hours, not 24", [dst.todayStart.toISOString(), dst.todayEnd.toISOString(), dst.weekStart.toISOString()], ["2026-10-03T14:00:00.000Z", "2026-10-04T13:00:00.000Z", "2026-09-27T14:00:00.000Z"]);
  const sunday = ranges(new Date("2026-10-25T05:00:00Z"), SYD); // Sunday 25 Oct 16:00: still the week that began Mon 19th
  check("a Sunday belongs to the week that began the Monday before", sunday.weekStart.toISOString(), "2026-10-18T13:00:00.000Z");

  const rows = [
    { startsAt: "2026-10-22T13:00:00Z", service: "Cut", stylist: "Ana" },        // 00:00 today
    { startsAt: "2026-10-23T12:59:00Z", service: "Colour", stylist: "Ana" },     // 23:59 today
    { startsAt: "2026-10-23T13:00:00Z", service: "Trim", stylist: "Ana" },       // 00:00 Saturday
    { startsAt: "2026-10-18T12:59:00Z", service: "Last week", stylist: "Ana" },  // Sunday 23:59, previous week
    { startsAt: "2026-10-24T03:00:00Z", service: "Perm", stylist: "Ben" },       // Saturday
    { startsAt: "2026-10-25T12:59:00Z", service: "Last minute", stylist: "Ben" },// Sunday 23:59, this week
    { startsAt: "2026-10-25T13:00:00Z", service: "Next week", stylist: "Ben" },  // Monday 00:00, next week
    { startsAt: "2026-10-22T23:00:00Z", service: "Wash", stylist: "  " },        // 10:00 today, no stylist
  ];
  for (const order of [rows, [...rows].reverse()]) {
    const ros = buildRoster(order, now, SYD);
    check("counts per stylist, today and this week", ros.stylists.map((s) => [s.stylist, s.today, s.week]), [["Ana", 2, 3], ["Ben", 0, 2], ["Unassigned", 1, 1]]);
    check("today's list is in time order with local times", ros.stylists[0].bookings.map((b) => [b.time, b.service]), [["12:00 am", "Cut"], ["11:59 pm", "Colour"]]);
  }

  // --- 2. Refuses to start without sign-in configured ------------------------------------------
  const noAppId = await startApp({ VMNODES_PORTAL_URL: "http://127.0.0.1:1" });
  check("refuses to START without VMNODES_APP_ID", noAppId.exited !== undefined && noAppId.exited !== 0, true);
  check("...and the message names the missing setting", /VMNODES_APP_ID is required/.test(noAppId.out()), true);

  // --- 3. The real run: pretend portal, pretend data API, app ------------------------------------
  const nowMs = Date.now(), DAY = 864e5;
  const bookings = [
    { startsAt: new Date(nowMs).toISOString(), service: "Cut and blow dry", stylist: "Ana <b>" },
    { startsAt: new Date(nowMs).toISOString(), service: "Colour", stylist: "Ben" },
    { startsAt: new Date(nowMs - 8 * DAY).toISOString(), service: "Long ago", stylist: "Zed" },
    { startsAt: new Date(nowMs + 8 * DAY).toISOString(), service: "Far ahead", stylist: "Zed" },
  ];
  const data = await startMockDataApi({ token: TOKEN, bookings });
  const portal = await startMockPortal({ port: 0, appId: APP_ID });
  const env = { VMNODES_PORTAL_URL: portal.issuer, VMNODES_APP_ID: APP_ID, SHARED_DATA_URL: data.url, SHARED_DATA_TOKEN: TOKEN, ROSTER_TZ: SYD };
  const app = await startApp(env);
  portal.setTarget(app.url);
  const { privateKey } = await generateKeyPair("RS256"); // a key the portal does not publish
  const good = (roles) => token(portal, portal.privateKey, { sub: "usr_1", roles });

  const health = await request(`${app.url}/health`);
  check("health answers without sign-in", [health.status, health.json().status], [200, "ok"]);
  check("no identity header -> 401", (await request(`${app.url}/api/roster`)).status, 401);
  check("a token signed with the wrong key -> 401", (await request(`${app.url}/api/roster`, { headers: { "x-vmnodes-identity": await token(portal, privateKey, { sub: "usr_1", roles: ["roster.viewer"] }) } })).status, 401);
  check("a token for another app -> 401", (await request(`${app.url}/api/roster`, { headers: { "x-vmnodes-identity": await token(portal, portal.privateKey, { sub: "usr_1", roles: ["roster.viewer"], aud: "app_other" }) } })).status, 401);
  check("signed in without the role -> 403 on the API", (await request(`${app.url}/api/roster`, { headers: { "x-vmnodes-identity": await good([]) } })).status, 403);
  check("signed in without the role -> 403 on the page", (await request(`${app.url}/`, { headers: { "x-vmnodes-identity": await good([]) } })).status, 403);
  check("...and nothing was read from the data API for them", data.seen.length, 0);

  const ok = await request(`${app.url}/api/roster`, { headers: { "x-vmnodes-identity": await good(["roster.viewer"]) } });
  check("with the role -> 200", ok.status, 200);
  const j = ok.json();
  check("it asks for exactly the three shared fields of the booking entity, this week only", [data.seen[0].entity, data.seen[0].select, data.seen[0].filter.map((f) => f.op), data.seen[0].filter[0].value < data.seen[0].filter[1].value], ["bench-bookings.booking", ["startsAt", "service", "stylist"], ["gte", "lt"], true]);
  check("each stylist has today and week counts; bookings outside this week are not counted", j.stylists.map((s) => [s.stylist, s.today, s.week]), [["Ana <b>", 1, 1], ["Ben", 1, 1]]);
  const html = await request(`${app.url}/`, { headers: { "x-vmnodes-identity": await good(["roster.viewer"]) } });
  check("the page escapes stylist text", [html.body.includes("Ana &lt;b&gt;"), html.body.includes("Ana <b>")], [true, false]);
  check("the page lists today's bookings", [html.body.includes("Cut and blow dry"), html.body.includes("Colour"), html.body.includes("Long ago")], [true, true, false]);
  check("nothing can be changed: POST -> 405", (await request(`${app.url}/`, { method: "POST", headers: { "x-vmnodes-identity": await good(["roster.viewer"]) } })).status, 405);
  check("a POST without sign-in is still 401, not 405", (await request(`${app.url}/`, { method: "POST" })).status, 401);

  // --- 4. Not connected, and refused ------------------------------------------------------------
  const lone = await startApp({ VMNODES_PORTAL_URL: portal.issuer, VMNODES_APP_ID: APP_ID });
  portal.setTarget(lone.url);
  const nc = await request(`${lone.url}/`, { headers: { "x-vmnodes-identity": await good(["roster.viewer"]) } });
  check("with no data access the page says so, with no error", [nc.status, nc.body.includes("not connected yet")], [200, true]);
  const badTok = await startApp({ ...env, SHARED_DATA_TOKEN: "wrong" });
  const rf = await request(`${badTok.url}/`, { headers: { "x-vmnodes-identity": await good(["roster.viewer"]) } });
  check("a refusal from the platform shows its own message", [rf.status, rf.body.includes("a valid API token is required")], [200, true]);
  check("...and never shows the token", rf.body.includes("wrong"), false);

  const FLOOR = 27;
  if (pass + fail < FLOOR) { console.log(`FAIL only ${pass + fail} checks ran, expected at least ${FLOOR}`); fail++; }
  console.log(`\npassed=${pass} failed=${fail}`);
  for (const c of children) c.kill();
  portal.server.close(); data.server.close();
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.error("FAIL the test itself crashed:", e); for (const c of children) c.kill(); process.exit(1); });
