// dev/mock-data-api.js: a PRETEND shared-data API for your own computer only. It answers
// POST /v1/data/query like the platform does, from a list of bookings, and applies the filter,
// order and limit it is sent, so the roster's query is really exercised.
const http = require("node:http");

const ENTITY = "bench-bookings.booking";

function startMockDataApi({ token, bookings, port = 0, limitMax = 200 }) {
  const seen = [];
  const server = http.createServer((req, res) => {
    let raw = ""; req.on("data", (d) => (raw += d));
    req.on("end", () => {
      const reply = (status, body) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(body)); };
      if (req.method !== "POST" || req.url !== "/v1/data/query") return reply(404, { error: { code: "api/not-found", message: "no such resource" } });
      if (req.headers.authorization !== `Bearer ${token}`) return reply(401, { error: { code: "auth/unauthorised", message: "a valid API token is required" } });
      const q = JSON.parse(raw);
      seen.push(q);
      if (q.entity !== ENTITY) return reply(422, { error: { code: "data/denied", message: `no query access to '${q.entity}'` } });
      for (const f of q.select || []) if (!["startsAt", "service", "stylist"].includes(f)) return reply(422, { error: { code: "data/field-denied", message: `field '${f}' is not available to you on '${q.entity}'` } });
      let rows = bookings.filter((b) => (q.filter || []).every((f) => {
        const v = b[f.field];
        if (f.op === "gte") return v >= f.value;
        if (f.op === "lt") return v < f.value;
        if (f.op === "eq") return v === f.value;
        throw new Error(`mock does not implement ${f.op}`);
      }));
      if (q.orderBy) rows = [...rows].sort((a, b) => (a[q.orderBy.field] < b[q.orderBy.field] ? -1 : 1) * (q.orderBy.dir === "desc" ? -1 : 1));
      const limit = Math.min(q.limit || 50, limitMax);
      const out = rows.slice(0, limit).map((b) => Object.fromEntries(q.select.map((f) => [f, b[f]])));
      reply(200, { rows: out, provenance: { entity: `${ENTITY}/v1`, source: "bench-bookings", freshestAt: "2026-01-01T00:00:00.000Z", stalestAt: "2026-01-01T00:00:00.000Z" }, truncated: rows.length > limit, truncation: rows.length > limit ? "scan" : "none", rowCount: out.length });
    });
  });
  return new Promise((resolve) => server.listen(port, "127.0.0.1", () => resolve({ server, seen, url: `http://127.0.0.1:${server.address().port}` })));
}

module.exports = { startMockDataApi };
