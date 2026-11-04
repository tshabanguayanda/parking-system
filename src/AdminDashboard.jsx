import { useEffect, useMemo, useRef, useState } from "react";
import { supabase } from "./supabase";
import { SLOTS, fCard, fDate, fDay, fHM, fTime, fDur, fClock, dayKey, dayLabel, toArr } from "./lib";
import {
  CarIcon, TopBar, useNow, useToasts,
  useProfiles, useSensors, useLogs, useParkingSessions,
  useRfidReaders, useCardTaps, useTaps, useBoomGates, useFlameAlerts,
} from "./ui";

function buildSessions(logsAsc) {
  const open = {}, out = [];
  for (const e of logsAsc) {
    if (e.type === "IN") {
      open[e.slot] = { slot: e.slot, inT: e.t, card: e.card, name: e.name, outT: null };
      out.push(open[e.slot]);
    } else if (e.type === "OUT" && open[e.slot]) {
      open[e.slot].outT = e.t;
      open[e.slot] = null;
    }
  }
  return out.reverse();
}

function DayChart({ logs }) {
  const days = useMemo(() => {
    const m = {};
    logs.forEach((e) => { const k = dayKey(e.t); m[k] = m[k] || { in: 0, out: 0 }; e.type === "IN" ? m[k].in++ : m[k].out++; });
    return Object.keys(m).sort().slice(-10).map((k) => ({ k, ...m[k] }));
  }, [logs]);
  const max = Math.max(1, ...days.map((d) => Math.max(d.in, d.out)));
  const H = 150, bw = 34, gap = 22, W = days.length * (bw * 2 + gap) + gap;
  return (
    <div className="chart">
      <svg viewBox={`0 0 ${Math.max(W, 260)} ${H + 34}`} width="100%" role="img" aria-label="Entries and exits per day">
        {days.map((d, i) => {
          const x = gap + i * (bw * 2 + gap);
          const hi = (d.in / max) * H, ho = (d.out / max) * H;
          return (
            <g key={d.k}>
              <rect x={x} y={H - hi} width={bw - 4} height={hi} rx="6" fill="#5b3df6" />
              <rect x={x + bw} y={H - ho} width={bw - 4} height={ho} rx="6" fill="#f2a91c" />
              <text x={x + bw - 2} y={H - hi - 6} textAnchor="middle" className="tick">{d.in}</text>
              <text x={x + bw * 2 - 6} y={H - ho - 6} textAnchor="middle" className="tick">{d.out}</text>
              <text x={x + bw - 2} y={H + 20} textAnchor="middle" className="tick">{dayLabel(d.k).slice(0, 6)}</text>
            </g>
          );
        })}
      </svg>
      <div className="legend"><span><i style={{ background: "#5b3df6" }} />Cars in</span><span><i style={{ background: "#f2a91c" }} />Cars out</span></div>
    </div>
  );
}

/** What a card tap means, for the live detections feed. */
function tapResult(tap, { cardToUid, users }) {
  const uid = cardToUid?.[tap.card];
  const who = uid ? users?.[uid]?.name || users?.[uid]?.email : null;
  if (who) return { who, tone: "green", text: "Registered driver" };
  return { who: "Unknown card", tone: "red", text: "Not registered to anyone" };
}

export default function AdminDashboard({ user }) {
  const now = useNow(1000);
  const [toast, toasts] = useToasts();
  const [msg, setMsg] = useState("");

  const sensors = useSensors();
  const logsObj = useLogs(1000);
  const sessionsArr = useParkingSessions();
  const users = useProfiles();
  const readers = useRfidReaders();
  const cardTaps = useCardTaps();
  const tapsArr = useTaps(25);
  const gates = useBoomGates();
  const flameAlerts = useFlameAlerts();

  const [tab, setTab] = useState("sessions");
  const [slot, setSlot] = useState("all");
  const [day, setDay] = useState("all");

  const cardToUid = useMemo(() => Object.fromEntries(
    Object.entries(users || {}).filter(([, u]) => u.card).map(([uid, u]) => [u.card, uid]),
  ), [users]);
  const logs = useMemo(() => toArr(logsObj).sort((a, b) => a.t - b.t).map((e) => (
    e.name || !e.card ? e : { ...e, name: users?.[cardToUid?.[e.card]]?.name || "" })), [logsObj, users, cardToUid]);
  const taps = useMemo(() => [...(tapsArr || [])].sort((a, b) => b.t - a.t), [tapsArr]);
  const sessions = useMemo(() => (sessionsArr || []).slice().sort((a, b) => b.entry - a.entry), [sessionsArr]);
  const bays = useMemo(() => buildSessions(logs), [logs]);
  const ctx = { cardToUid, users };

  /* live notifications */
  const seenTap = useRef(null);
  useEffect(() => {
    if (!taps.length) return;
    if (seenTap.current) {
      taps.filter((t) => t.t > seenTap.current).reverse().forEach((t) => {
        const r = tapResult(t, ctx);
        toast(`💳 ${fCard(t.card)} at ${t.reader}: ${r.who} – ${r.text}`, r.tone);
      });
    }
    seenTap.current = taps[0].t;
  }, [taps]); // eslint-disable-line
  const seenS = useRef(null);
  useEffect(() => {
    if (!sessionsArr) return;
    const prev = seenS.current;
    if (prev) sessions.forEach((s) => {
      const p = prev[s.id];
      if (!p) toast(`🚗 ${users?.[s.uid]?.name || "A driver"} parked – card ${fCard(s.card)}`, "green");
      else if (p !== s.status && s.status === "completed") toast(`👋 ${users?.[s.uid]?.name || "A driver"} left after ${fDur((s.exit || now) - s.entry)} – +${s.pointsEarned} pts`, "blue");
    });
    seenS.current = Object.fromEntries(sessions.map((s) => [s.id, s.status]));
  }, [sessionsArr]); // eslint-disable-line

  /* numbers */
  const today = dayKey(now);
  const active = sessions.filter((s) => s.status === "active");
  const todaySessions = sessions.filter((s) => dayKey(s.entry) === today);
  const pointsToday = sessions.filter((s) => s.exit && dayKey(s.exit) === today).reduce((a, s) => a + (s.pointsEarned || 0), 0);
  const occupied = (k) => k !== "P1" && !!sensors?.[k]?.occupied;
  const free = SLOTS.filter((k) => !occupied(k)).length;
  const days = useMemo(() => [...new Set(logs.map((e) => dayKey(e.t)))].sort().reverse(), [logs]);
  const ok = (t, s) => (slot === "all" || s === slot) && (day === "all" || dayKey(t) === day);

  const fSessions = sessions.filter((s) => day === "all" || dayKey(s.entry) === day);

  const toggleGate = (id, maintenance) =>
    supabase.from("boom_gates").update({ maintenance: !maintenance }).eq("id", id)
      .then(({ error }) => { if (error) setMsg(error.message); });
  const unresolvedAlert = (flameAlerts || []).find((a) => !a.resolved_at);
  const resolveAlert = (id) =>
    supabase.from("flame_alerts").update({ resolved_at: new Date().toISOString(), resolved_by: user.uid }).eq("id", id)
      .then(({ error }) => { if (error) setMsg(error.message); });
  const triggerEmergency = () => {
    if (!window.confirm("Force BOTH boom gates open for a real emergency?")) return;
    supabase.from("flame_alerts").insert({}).then(({ error }) => { if (error) setMsg(error.message); });
  };

  return (
    <div className="app">
      <TopBar user={user} role="admin" />
      <main className="wrap">
        <div className="title-row">
          <div>
            <h1>Parking control</h1>
            <p className="muted">Cars parked, RFID detections and bay sensors – live from Supabase</p>
          </div>
        </div>
        {msg && <div className="err">{msg}</div>}

        {unresolvedAlert ? (
          <div className="err" style={{ display: "flex", justifyContent: "space-between", alignItems: "center", fontWeight: 700 }}>
            🚨 EMERGENCY ACTIVE — both gates forced open ({fTime(new Date(unresolvedAlert.triggered_at).getTime())})
            <button className="btn sm" onClick={() => resolveAlert(unresolvedAlert.id)}>Clear emergency</button>
          </div>
        ) : (
          <section className="card" style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
            <div>
              <h3 style={{ marginBottom: 2 }}>Emergency</h3>
              <p className="muted" style={{ margin: 0 }}>Forces both boom gates open immediately — only use this for a real emergency.</p>
            </div>
            <button
              className="btn"
              style={{ background: "#dc2626", color: "#fff", border: 0, fontWeight: 700 }}
              onClick={triggerEmergency}
            >
              🚨 Trigger emergency
            </button>
          </section>
        )}

        <section className="card">
          <h3>Gate maintenance</h3>
          <p className="muted">Put a gate into maintenance before working on its servo — card taps won't open it until you re-enable it.</p>
          <div className="row">
            {["entry", "exit"].map((id) => {
              const g = gates?.[id];
              return (
                <div key={id} className="bitem grow">
                  <div className="grow"><b>{g?.label || id}</b><div className={g?.maintenance ? "bad" : "ok"}>{g?.maintenance ? "Under maintenance" : "Enabled"}</div></div>
                  <button className={"btn sm" + (g?.maintenance ? "" : " primary")} onClick={() => toggleGate(id, g?.maintenance)}>
                    {g?.maintenance ? "Re-enable" : "Set maintenance"}
                  </button>
                </div>
              );
            })}
          </div>
        </section>

        <section className="stats">
          <div className="stat"><span>Free bays now</span><b>{free}<small> / {SLOTS.length}</small></b></div>
          <div className="stat"><span>Cars parked now</span><b>{active.length}</b></div>
          <div className="stat"><span>Cars today</span><b>{todaySessions.length}</b></div>
          <div className="stat"><span>Points given today</span><b>{pointsToday}</b></div>
        </section>

        <section className="grid2">
          <div className="card">
            <h3>Live bays</h3>
            <div className="slots">
              {SLOTS.map((k) => {
                if (k === "P1") {
                  return (
                    <div key={k} className="slot free">
                      <div className="slot-top"><span className="slot-id">P1</span><span className="pill green">Empty</span></div>
                      <div className="car"><CarIcon size={40} /></div>
                      <div className="slot-info"><div className="muted">Available</div></div>
                    </div>
                  );
                }
                const occ = occupied(k);
                const s = sensors?.[k];
                const current = occ ? bays.find((x) => x.slot === k && !x.outT) : null;
                return (
                  <div key={k} className={"slot " + (occ ? "occ" : "free")}>
                    <div className="slot-top"><span className="slot-id">{k}</span><span className={"pill " + (occ ? "red" : "green")}>{occ ? "Car detected" : "Empty"}</span></div>
                    <div className="car"><CarIcon size={40} /></div>
                    <div className="slot-info">
                      {current ? (<>
                        <div><b>{current.name || "Unregistered car"}</b></div>
                        <div className="muted">since {fHM(current.inT)} · {fDur(now - current.inT)}</div>
                      </>) : occ ? (
                        <div className="muted">Car in bay</div>
                      ) : <div className="muted">Available</div>}
                      {s?.distance != null && <div className="muted tiny">Sensor {Math.round(s.distance)} cm · {s.t ? fTime(s.t) : ""}</div>}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>

          <div className="card">
            <h3>Live RFID detections</h3>
            {readers && <div className="readers">{Object.entries(readers).map(([r, v]) => <span key={r} className="pill gray">{r}: last tap {v?.t ? fHM(v.t) : "—"}</span>)}</div>}
            <div className="feed">
              {!taps.length && <p className="muted">No card taps yet. When a card touches the reader it appears here instantly.</p>}
              {taps.slice(0, 12).map((t) => {
                const r = tapResult(t, ctx);
                return (
                  <div key={t.id} className={"feed-item " + (now - t.t < 15000 ? "fresh" : "")}>
                    <span className={"dot " + r.tone} />
                    <div className="grow">
                      <div><b>{r.who}</b> <code>{fCard(t.card)}</code></div>
                      <div className="muted">{r.text}</div>
                    </div>
                    <div className="muted right">{fTime(t.t)}<div className="tiny">{t.reader}</div></div>
                  </div>
                );
              })}
            </div>
          </div>
        </section>

        <section className="card">
          <div className="tabs-row">
            <div className="seg wrap-seg">
              {[["sessions", "Sessions"], ["drivers", "Drivers & cards"], ["activity", "Activity log"]].map(([k, l]) => (
                <button key={k} className={tab === k ? "on" : ""} onClick={() => setTab(k)}>{l}</button>
              ))}
            </div>
            {["sessions", "activity"].includes(tab) && (
              <div className="filters">
                {tab === "activity" && (
                  <select value={slot} onChange={(e) => setSlot(e.target.value)}><option value="all">All bays</option>{SLOTS.map((id) => <option key={id}>{id}</option>)}</select>
                )}
                <select value={day} onChange={(e) => setDay(e.target.value)}>
                  <option value="all">All dates</option>
                  {days.map((d) => <option key={d} value={d}>{dayLabel(d)}</option>)}
                </select>
              </div>
            )}
          </div>

          {tab === "sessions" && (<>
            {logs.length > 0 && <DayChart logs={logs} />}
            {fSessions.length ? (
              <div className="scroll"><table>
                <thead><tr><th>Driver</th><th>Card</th><th>Entered</th><th>Left</th><th>Time parked</th><th>Points</th><th>Status</th></tr></thead>
                <tbody>{fSessions.slice(0, 300).map((s) => (
                  <tr key={s.id}>
                    <td><b>{users?.[s.uid]?.name || users?.[s.uid]?.email || "—"}</b></td>
                    <td><code>{fCard(s.card)}</code></td>
                    <td><div>{fDate(s.entry)}</div><div className="muted">{fTime(s.entry)}</div></td>
                    <td>{s.exit ? <><div>{fDate(s.exit)}</div><div className="muted">{fTime(s.exit)}</div></> : "—"}</td>
                    <td>{s.status === "active" ? <span className="clock xs">{fClock(now - s.entry)}</span> : s.exit ? fDur(s.exit - s.entry) : "—"}</td>
                    <td>{s.pointsEarned ? <span className="pill green">+{s.pointsEarned}</span> : "—"}</td>
                    <td><span className={"pill " + (s.status === "active" ? "blue" : "gray")}>{s.status === "active" ? "Parked now" : "Completed"}</span></td>
                  </tr>
                ))}</tbody>
              </table></div>
            ) : <div className="empty"><p>No parking sessions yet.</p></div>}
          </>)}

          {tab === "drivers" && (
            <div className="scroll"><table>
              <thead><tr><th>Driver</th><th>Email</th><th>RFID card</th><th>Points</th><th>Last tap</th><th>Visits</th></tr></thead>
              <tbody>
                {Object.entries(users || {}).filter(([, u]) => u.card).map(([uid, u]) => (
                  <tr key={uid}>
                    <td><b>{u.name || "—"}</b></td><td>{u.email}</td><td><code>{fCard(u.card)}</code></td>
                    <td>{u.points || 0}</td>
                    <td>{cardTaps?.[u.card] ? `${fDay(cardTaps[u.card].t)} ${fHM(cardTaps[u.card].t)}` : "—"}</td>
                    <td>{sessions.filter((s) => s.uid === uid).length}</td>
                  </tr>
                ))}
                {!Object.values(users || {}).some((u) => u.card) && <tr><td colSpan="6" className="muted">No drivers have registered a card yet.</td></tr>}
              </tbody>
            </table></div>
          )}

          {tab === "activity" && (
            <div className="scroll"><table>
              <thead><tr><th>Timestamp</th><th>Event</th><th>Bay</th><th>Driver</th><th>Card ID</th></tr></thead>
              <tbody>{[...logs].reverse().filter((e) => ok(e.t, e.slot)).slice(0, 200).map((e) => (
                <tr key={e.id}>
                  <td><b>{fTime(e.t)}</b> <span className="muted">· {fDate(e.t)}</span></td>
                  <td><span className={"pill " + (e.type === "IN" ? "blue" : "amber")}>{e.type === "IN" ? "↓ Car parked (IN)" : "↑ Car left (OUT)"}</span></td>
                  <td><b>{e.slot}</b></td><td>{e.name || "—"}</td><td><code>{e.card || "—"}</code></td>
                </tr>))}
                {!logs.length && <tr><td colSpan="5" className="muted">No activity yet.</td></tr>}
              </tbody>
            </table></div>
          )}
        </section>
      </main>
      {toasts}
    </div>
  );
}
