import { useEffect, useState } from "react";
import { supabase } from "./supabase";
import { mapSession } from "./lib";

export const CarIcon = ({ size = 24 }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
    <path d="M5 16V11l2-5h10l2 5v5M3 16h18v3H3zM7 19v2M17 19v2" /><circle cx="8" cy="13.5" r=".6" /><circle cx="16" cy="13.5" r=".6" />
  </svg>
);

// Brand mark: a raised boom gate — distinct from the generic "car" icon
// every other parking app uses, and literal to what this system actually
// does (open the barrier for a recognised card).
export const GateIcon = ({ size = 24 }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M3 20h4" />
    <circle cx="5.5" cy="20" r="1.5" fill="currentColor" stroke="none" />
    <path d="M5.5 20 19 6.5" />
    <path d="M19 6.5 21 8.5" />
    <path d="M16 9.5 18 11.5" strokeWidth="2.4" opacity="0.6" />
    <path d="M12.3 13.2 14.3 15.2" strokeWidth="2.4" opacity="0.6" />
    <path d="M8.6 16.9 10.6 18.9" strokeWidth="2.4" opacity="0.6" />
  </svg>
);

export function useNow(ms = 1000) {
  const [n, setN] = useState(Date.now());
  useEffect(() => { const i = setInterval(() => setN(Date.now()), ms); return () => clearInterval(i); }, [ms]);
  return n;
}

/**
 * Re-runs `select` whenever a row changes in `listen` (defaults to `select`'s own table),
 * and keeps the result live. Returns undefined while loading, null on a read error.
 * This mirrors Firebase's onValue: any change re-delivers the whole shaped snapshot.
 */
function useLive(listen, select, toValue, deps = [], filter) {
  const [data, setData] = useState(undefined);
  useEffect(() => {
    let alive = true;
    const load = async () => {
      const { data: rows, error } = await select();
      if (!alive) return;
      if (error) { console.warn(listen, error.message); setData(null); return; }
      setData(toValue(rows));
    };
    load();
    const spec = { event: "*", schema: "public", table: listen, ...(filter ? { filter } : {}) };
    const channel = supabase
      .channel(`rt-${listen}-${JSON.stringify(deps)}-${Math.random().toString(36).slice(2)}`)
      .on("postgres_changes", spec, load)
      .subscribe();
    return () => { alive = false; supabase.removeChannel(channel); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  return data;
}
const keyBy = (rows, k) => Object.fromEntries((rows || []).map((r) => [r[k], r]));

/* ---------- profiles ---------- */
export function useProfile(uid) {
  return useLive("profiles", () => supabase.from("profiles").select("*").eq("id", uid).maybeSingle(),
    (r) => r, [uid]);
}
export function useProfiles() {
  return useLive("profiles", () => supabase.from("profiles").select("*"),
    (rows) => keyBy(rows, "id"), []);
}

/* ---------- parking sessions (tap to park, tap to leave) ---------- */
export function useParkingSessions(uid) {
  return useLive("parking_sessions",
    () => (uid ? supabase.from("parking_sessions").select("*").eq("uid", uid) : supabase.from("parking_sessions").select("*")),
    (rows) => (rows || []).map(mapSession), [uid],
    uid ? `uid=eq.${uid}` : undefined);
}

/* ---------- hardware ---------- */
export function useSensors() {
  return useLive("sensors", () => supabase.from("sensors").select("*"), (rows) => keyBy(rows, "slot"), []);
}
export function useRfidReaders() {
  return useLive("rfid", () => supabase.from("rfid").select("*"), (rows) => keyBy(rows, "reader"), []);
}
export function useCardTaps() {
  return useLive("card_taps", () => supabase.from("card_taps").select("*"), (rows) => keyBy(rows, "card"), []);
}
export function useCardTap(card) {
  return useLive("card_taps",
    () => (card ? supabase.from("card_taps").select("*").eq("card", card).maybeSingle() : Promise.resolve({ data: null })),
    (r) => r, [card], card ? `card=eq.${card}` : undefined);
}
export function useTaps(limit = 25) {
  return useLive("taps", () => supabase.from("taps").select("*").order("t", { ascending: false }).limit(limit),
    (rows) => rows || [], [limit]);
}
export function useLogs(limit = 1000) {
  return useLive("logs", () => supabase.from("logs").select("*").order("t", { ascending: true }).limit(limit),
    (rows) => Object.fromEntries((rows || []).map((r) => [r.id, r])), [limit]);
}
export function useBoomGates() {
  return useLive("boom_gates", () => supabase.from("boom_gates").select("*"), (rows) => keyBy(rows, "id"), []);
}
export function useFlameAlerts(limit = 10) {
  return useLive("flame_alerts",
    () => supabase.from("flame_alerts").select("*").order("triggered_at", { ascending: false }).limit(limit),
    (rows) => rows || [], [limit]);
}

export function TopBar({ user, role, extra }) {
  const name = user.displayName || user.email;
  return (
    <header className="top">
      <div className="logo dark"><GateIcon size={24} /> Crossing <em>Mall</em> <span className={"role " + role}>{role === "admin" ? "Admin" : "Driver"}</span></div>
      <div className="who">
        {extra}
        <span className="live-dot" title="Live connection to Supabase" />
        <div className="avatar">{(name || "?")[0].toUpperCase()}</div>
        <span className="hide-sm">{name}</span>
        <button className="btn ghost" onClick={() => supabase.auth.signOut()}>Sign out</button>
      </div>
    </header>
  );
}

/* ---------- toasts ---------- */
export function useToasts() {
  const [list, setList] = useState([]);
  const add = (text, tone = "blue") => {
    const id = Math.random().toString(36).slice(2);
    setList((l) => [...l.slice(-3), { id, text, tone }]);
    setTimeout(() => setList((l) => l.filter((x) => x.id !== id)), 6000);
  };
  const view = (
    <div className="toasts" aria-live="polite">
      {list.map((t) => <div key={t.id} className={"toast " + t.tone}>{t.text}</div>)}
    </div>
  );
  return [add, view];
}
