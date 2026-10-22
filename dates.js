// dates.js: "today" and "this week" in the salon's own time zone, and the roster built from bookings.
// Pure functions, so they can be tested without a server.

// Offset of a time zone from UTC at an instant, in milliseconds (positive east of UTC).
function offsetMs(date, tz) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" })
      .formatToParts(date).map((p) => [p.type, p.value]),
  );
  const asUtc = Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour, +parts.minute, +parts.second);
  return asUtc - Math.floor(date.getTime() / 1000) * 1000;
}

// The UTC instant at which the calendar day y-m-d begins in the zone. d may overflow the month.
function startOfLocalDay(y, m, d, tz) {
  const guess = Date.UTC(y, m - 1, d);
  const off1 = offsetMs(new Date(guess), tz);
  let t = guess - off1;
  const off2 = offsetMs(new Date(t), tz);
  if (off2 !== off1) t = guess - off2;
  return new Date(t);
}

function localYmd(date, tz) {
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(date).map((x) => [x.type, x.value]));
  return { y: +p.year, m: +p.month, d: +p.day };
}

// { todayStart, todayEnd, weekStart, weekEnd } as Dates. The week runs Monday to Sunday.
function ranges(now, tz) {
  const { y, m, d } = localYmd(now, tz);
  const dow = new Date(Date.UTC(y, m - 1, d)).getUTCDay(); // 0 = Sunday
  const sinceMonday = (dow + 6) % 7;
  return {
    todayStart: startOfLocalDay(y, m, d, tz),
    todayEnd: startOfLocalDay(y, m, d + 1, tz),
    weekStart: startOfLocalDay(y, m, d - sinceMonday, tz),
    weekEnd: startOfLocalDay(y, m, d - sinceMonday + 7, tz),
  };
}

// Builds [{ stylist, today, week, bookings: [{ startsAt, time, service }] }] from rows { startsAt, service, stylist }.
// A row outside this week is ignored, so a wrong filter upstream cannot inflate a count.
function buildRoster(rows, now, tz) {
  const r = ranges(now, tz);
  const timeFmt = new Intl.DateTimeFormat("en-AU", { timeZone: tz, hour: "numeric", minute: "2-digit", hour12: true });
  const by = new Map();
  for (const row of rows) {
    const at = new Date(row.startsAt);
    if (Number.isNaN(at.getTime())) continue;
    if (at < r.weekStart || at >= r.weekEnd) continue;
    const stylist = String(row.stylist ?? "").trim() || "Unassigned";
    if (!by.has(stylist)) by.set(stylist, { stylist, today: 0, week: 0, bookings: [] });
    const s = by.get(stylist);
    s.week++;
    if (at >= r.todayStart && at < r.todayEnd) {
      s.today++;
      s.bookings.push({ startsAt: at.toISOString(), time: timeFmt.format(at).replace(/\s/g, " "), service: String(row.service ?? "") });
    }
  }
  const list = [...by.values()].sort((a, b) => a.stylist.localeCompare(b.stylist));
  for (const s of list) s.bookings.sort((a, b) => a.startsAt.localeCompare(b.startsAt));
  return { range: { todayStart: r.todayStart.toISOString(), todayEnd: r.todayEnd.toISOString(), weekStart: r.weekStart.toISOString(), weekEnd: r.weekEnd.toISOString() }, stylists: list };
}

module.exports = { ranges, buildRoster, startOfLocalDay };
