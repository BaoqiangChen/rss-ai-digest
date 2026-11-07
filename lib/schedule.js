"use strict";
// Schedule maths (local time). Pure functions so they can be unit-tested.
var RCD = (globalThis.RCD = globalThis.RCD || {});

RCD.schedule = (() => {
  const ALL_DAYS = [0, 1, 2, 3, 4, 5, 6];
  const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

  function parseTime(t) {
    const m = /^(\d{1,2}):(\d{2})/.exec(String(t || ""));
    if (!m) return [7, 30];
    return [Math.min(23, +m[1]), Math.min(59, +m[2])];
  }

  function days(s) {
    return Array.isArray(s.days) && s.days.length ? s.days.map(Number) : ALL_DAYS;
  }

  /** Next daily occurrence strictly after `from`. */
  function nextDaily(s, from) {
    const [hh, mm] = parseTime(s.time);
    const ds = days(s);
    for (let i = 0; i <= 7; i++) {
      const d = new Date(from.getFullYear(), from.getMonth(), from.getDate() + i, hh, mm, 0, 0);
      if (d > from && ds.includes(d.getDay())) return d;
    }
    return null;
  }

  /** Most recent daily occurrence at or before `from`. */
  function prevDaily(s, from) {
    const [hh, mm] = parseTime(s.time);
    const ds = days(s);
    for (let i = 0; i <= 7; i++) {
      const d = new Date(from.getFullYear(), from.getMonth(), from.getDate() - i, hh, mm, 0, 0);
      if (d <= from && ds.includes(d.getDay())) return d;
    }
    return null;
  }

  /**
   * When should this topic run next?
   * Catches up a missed daily run (e.g. Thunderbird was closed at 07:30) if it was missed within `catchUpHours`.
   */
  function nextRunTime(topic, state, now = new Date(), { catchUpHours = 12, startupDelayMs = 90000 } = {}) {
    const s = topic.schedule || {};
    if (!topic.enabled || !s.type || s.type === "manual") return null;
    const lastRun = state && state.lastRun ? new Date(state.lastRun) : null;

    if (s.type === "interval") {
      const h = Math.max(1, Number(s.hours) || 6);
      if (!lastRun) return new Date(now.getTime() + startupDelayMs);
      const due = new Date(lastRun.getTime() + h * 3600e3);
      return due > now ? due : new Date(now.getTime() + startupDelayMs);
    }

    // daily
    const prev = prevDaily(s, now);
    if (prev && (!lastRun || lastRun < prev) && now - prev < catchUpHours * 3600e3) {
      return new Date(now.getTime() + startupDelayMs);
    }
    return nextDaily(s, now);
  }

  function describe(s) {
    if (!s || !s.type || s.type === "manual") return "Manual";
    if (s.type === "interval") return `Every ${Math.max(1, Number(s.hours) || 6)} h`;
    const ds = days(s);
    let dayText;
    if (ds.length === 7) dayText = "Daily";
    else if (ds.length === 5 && [1, 2, 3, 4, 5].every((d) => ds.includes(d))) dayText = "Weekdays";
    else dayText = ds.slice().sort().map((d) => DAY_NAMES[d]).join(", ");
    const [hh, mm] = parseTime(s.time);
    return `${dayText} ${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}`;
  }

  return { parseTime, nextDaily, prevDaily, nextRunTime, describe, DAY_NAMES };
})();
