/*
 * Shared logic for the user portal and the admin dashboard.
 *
 * Database layout (Supabase / Postgres – see supabase/schema.sql)
 * ------------------------------------------------------------------
 * profiles(id, name, email, card, role, points)        – driver/admin profile
 * parking_sessions(id, uid, card, entry_time, exit_time, duration_minutes,
 *                   points_earned, status: active|completed)
 *   – one row per visit. No booking, no assigned bay: a driver taps when
 *     they arrive (opens the entry gate, starts a session) and taps again
 *     when they leave (opens the exit gate, closes the session, awards
 *     points). Both the "which gate" decision and the points award happen
 *     in fn_gate_tap (schema.sql), so they're correct no matter which
 *     client — or no client at all — is open when the tap happens.
 * sensors(slot, occupied, distance, t)                 – written by the ESP32 (IR)
 * rfid(reader, card, t)                                 – last tap on each reader (ESP32)
 * card_taps(card, reader, t)                            – last tap of each card (ESP32)
 * taps(id, reader, card, t)                             – tap history (ESP32)
 * logs(id, slot, card, name, type IN|OUT, t)            – bay occupancy history (ESP32)
 */
import { PARKING_SLOTS } from "./seed";

export const SLOTS = PARKING_SLOTS;

/* ---------- loyalty points -> discount ---------- */
// +10 points per completed visit, awarded directly inside fn_gate_tap
// (schema.sql) the moment a driver's exit tap closes their session. Every
// 100 points unlocks another 10% off, capped at 50%; points can also be
// redeemed directly as Rand value. Adjust freely to the mall's actual scheme.
export const POINTS_PER_VISIT = 10;
const POINTS_PER_TIER = 100;
const PERCENT_PER_TIER = 10;
const MAX_PERCENT = 50;
const RAND_PER_POINT = 0.5;
export function discountFor(points) {
  const p = points || 0;
  const percent = Math.min(MAX_PERCENT, Math.floor(p / POINTS_PER_TIER) * PERCENT_PER_TIER);
  const rand = Math.round(p * RAND_PER_POINT * 100) / 100;
  const toNext = percent >= MAX_PERCENT ? 0 : POINTS_PER_TIER - (p % POINTS_PER_TIER);
  return { percent, rand, toNext };
}

/* ---------- formatting ---------- */
export const fDate = (t) => new Date(t).toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" });
export const fDay = (t) => new Date(t).toLocaleDateString("en-GB", { weekday: "short", day: "2-digit", month: "short" });
export const fTime = (t) => new Date(t).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
export const fHM = (t) => new Date(t).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
export const fDur = (ms) => {
  const m = Math.max(0, Math.round(ms / 60000));
  return m < 60 ? `${m}m` : `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, "0")}m`;
};
export const fClock = (ms) => {
  const s = Math.max(0, Math.floor(ms / 1000));
  const p = (n) => String(n).padStart(2, "0");
  return `${p(Math.floor(s / 3600))}:${p(Math.floor((s % 3600) / 60))}:${p(s % 60)}`;
};
export const dayKey = (t) => {
  const d = new Date(t);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};
export const dayLabel = (k) => { const [y, m, d] = k.split("-").map(Number); return fDate(new Date(y, m - 1, d).getTime()); };
export const cleanCard = (s) => String(s || "").toUpperCase().replace(/[^0-9A-F]/g, "");
export const fCard = (c) => (c ? c.match(/.{1,2}/g).join(" ") : "—");

/* ---------- parking sessions ---------- */
export const mapSession = (r) => ({
  id: r.id, uid: r.uid, card: r.card, status: r.status,
  entry: Date.parse(r.entry_time), exit: r.exit_time ? Date.parse(r.exit_time) : null,
  durationMinutes: r.duration_minutes, pointsEarned: r.points_earned || 0,
});

/* ---------- misc ---------- */
export const toArr = (obj) => Object.entries(obj || {}).map(([id, v]) => ({ id, ...v }));
