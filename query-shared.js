// query-shared.js: reads another app's shared records with POST /v1/data/query.
// Returns { rows, truncated, provenance }. Throws an Error with .status and .code when the
// platform refuses, carrying the platform's own message. The token never goes in a message.
async function queryShared({ apiUrl, token, entity, select, filter, orderBy, limit }) {
  if (!apiUrl || !token) throw new Error("queryShared needs apiUrl and token");
  const res = await fetch(`${apiUrl}/v1/data/query`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify({ entity, select, filter, orderBy, limit }),
    signal: AbortSignal.timeout(15000),
  });
  const text = await res.text();
  let body;
  try { body = JSON.parse(text); } catch { body = null; }
  if (!res.ok) {
    const e = new Error(body?.error?.message || `query answered ${res.status}`);
    e.status = res.status;
    e.code = body?.error?.code;
    throw e;
  }
  return { rows: body.rows, truncated: body.truncated === true, provenance: body.provenance };
}

module.exports = { queryShared };
