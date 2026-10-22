// dev/run-local.js: `npm run dev`. Starts the roster, a pretend portal and a pretend shared-data API
// with made-up bookings around now, then open http://127.0.0.1:4100 in your browser.
// While it runs, visit /_as/reader (no role) or /_as/viewer (can see the roster) to switch.
const { spawn } = require("node:child_process");
const path = require("node:path");
const { startMockPortal } = require("./mock-portal");
const { startMockDataApi } = require("./mock-data-api");

const PORTAL_PORT = 4100, APP_PORT = 3000, APP_ID = "app_local_dev", TOKEN = "dev-token";

(async () => {
  const now = Date.now(), H = 3600e3;
  const at = (h) => new Date(now + h * H).toISOString();
  const bookings = [
    { startsAt: at(-1), service: "Cut and blow dry", stylist: "Ana" }, { startsAt: at(1), service: "Colour", stylist: "Ana" },
    { startsAt: at(2), service: "Trim", stylist: "Ben" }, { startsAt: at(30), service: "Cut", stylist: "Ben" },
  ];
  const data = await startMockDataApi({ token: TOKEN, bookings });
  const portal = await startMockPortal({ port: PORTAL_PORT, appUrl: `http://127.0.0.1:${APP_PORT}`, appId: APP_ID, as: process.argv[2] || "viewer" });
  const app = spawn(process.execPath, [path.join(__dirname, "..", "server.js")], {
    stdio: "inherit",
    env: { ...process.env, PORT: String(APP_PORT), VMNODES_PORTAL_URL: portal.issuer, VMNODES_APP_ID: APP_ID, SHARED_DATA_URL: data.url, SHARED_DATA_TOKEN: TOKEN },
  });
  app.on("exit", (code) => { console.log(`app exited (${code})`); process.exit(code || 0); });
  console.log(`\n  Open ${portal.issuer} in your browser.\n`);
  const stop = () => { app.kill(); portal.server.close(); data.server.close(); };
  process.on("SIGINT", stop); process.on("SIGTERM", stop);
})().catch((e) => { console.error(e.message); process.exit(1); });
