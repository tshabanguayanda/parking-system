import { useState } from "react";
import { supabase } from "./supabase";
import { cleanCard, fCard, fDate, fTime, fDur, fClock, discountFor } from "./lib";
import { GateIcon, TopBar, useNow, useProfile, useParkingSessions } from "./ui";

/* ---------- RFID card registration ---------- */
function CardSetup({ user, profile, onDone }) {
  const [name, setName] = useState(profile?.name && profile.name !== user.email ? profile.name : (user.displayName || ""));
  const [card, setCard] = useState(profile?.card || "");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  const save = async (e) => {
    e.preventDefault(); setErr("");
    const c = cleanCard(card);
    if (![8, 14, 20].includes(c.length)) return setErr("Enter the card UID printed by the reader – 8 hex characters (e.g. A1 B2 C3 D4), or 14 for 7-byte cards.");
    if (!name.trim()) return setErr("Enter your full name – the parking reader shows this when it recognises your card.");
    setBusy(true);
    try {
      const { error } = await supabase.from("profiles").update({
        name: name.trim(), email: user.email, card: c,
      }).eq("id", user.uid);
      if (error) throw error;
      onDone?.();
    } catch (x) { setErr(x.code === "23505" ? "That card is already registered to another driver. Ask the admin for help." : x.message); }
    setBusy(false);
  };

  return (
    <form className="card-setup" onSubmit={save}>
      <div className="rfid-art" aria-hidden="true"><span /><span /><span /></div>
      <div className="grow">
        <h3>{profile?.card ? "Your RFID card" : "Register your RFID card"}</h3>
        <p className="muted">This is how the gate reader recognises you. Tap it at the entrance to park and earn points, then tap again at the exit when you leave.</p>
        <div className="row">
          <label className="fld">Full name<input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Jane Doe" autoComplete="name" /></label>
          <label className="fld">Card number (UID)<input value={card} onChange={(e) => setCard(e.target.value)} placeholder="e.g. A1 B2 C3 D4" autoComplete="off" /></label>
        </div>
        <p className="hint">Not sure of your card number? Tap it on the reader once – the parking admin sees the number instantly in the Live RFID feed.</p>
        {err && <div className="err">{err}</div>}
        <button className="btn primary" disabled={busy}>{busy ? "Saving…" : profile?.card ? "Update card" : "Register card"}</button>
      </div>
    </form>
  );
}

/* ---------- loyalty points / discount ---------- */
function Rewards({ points }) {
  const { percent, rand, toNext } = discountFor(points);
  return (
    <section className="card stat" style={{ display: "grid", gap: 4 }}>
      <span>Your rewards</span>
      <div style={{ display: "flex", alignItems: "baseline", gap: 10, flexWrap: "wrap" }}>
        <b>{points}<small> pts</small></b>
        <span className="pill green">{percent}% off next visit</span>
        <span className="muted tiny">or R{rand.toFixed(2)} store credit</span>
      </div>
      {toNext > 0 && <span className="muted tiny">{toNext} more point{toNext === 1 ? "" : "s"} to your next discount tier</span>}
    </section>
  );
}

/* ---------- currently parked ---------- */
function ParkingStatus({ session, now, card }) {
  if (!session) {
    return (
      <section className="card hero">
        <span className="kicker">NOT PARKED</span>
        <h2>Tap your card to enter</h2>
        <p className="muted">
          {card ? <>Tap card <code>{fCard(card)}</code> at the entrance boom gate. It opens for you, and your timer starts.</>
            : "Register your card below first — then tap it at the entrance boom gate."}
        </p>
      </section>
    );
  }
  return (
    <section className="card hero active">
      <div className="hero-top">
        <div>
          <span className="kicker">YOU'RE PARKED</span>
          <h2>Timer running</h2>
          <p className="muted">Entered {fTime(session.entry)} on {fDate(session.entry)}</p>
        </div>
        <span className="pill green">Parked</span>
      </div>
      <div className="timer">
        <div className="clock">{fClock(now - session.entry)}</div>
        <div className="muted">Tap your card again at the exit gate to leave and earn points.</div>
      </div>
    </section>
  );
}

/* ---------- page ---------- */
export default function UserPortal({ user }) {
  const now = useNow(1000);
  const profile = useProfile(user.uid);
  const sessions = useParkingSessions(user.uid);
  const [editCard, setEditCard] = useState(false);

  if (profile === undefined || sessions === undefined) return <div className="splash"><GateIcon size={40} /></div>;

  const active = (sessions || []).find((s) => s.status === "active");
  const history = (sessions || []).filter((s) => s.status === "completed").sort((a, b) => b.entry - a.entry);

  return (
    <div className="app">
      <TopBar user={user} role="user" />
      <main className="wrap">
        <div className="title-row">
          <div>
            <h1>Hi {(user.displayName || profile?.name || "there").split(" ")[0]} 👋</h1>
            <p className="muted">Tap your card at the gate to park, tap again to leave and earn points.</p>
          </div>
          {profile?.card && !editCard && <button className="btn" onClick={() => setEditCard(true)}>Card {fCard(profile.card)} · change</button>}
        </div>

        <Rewards points={profile?.points || 0} />

        <ParkingStatus session={active} now={now} card={profile?.card} />

        {(!profile?.card || editCard) && (
          <section className="card"><CardSetup user={user} profile={profile} onDone={() => setEditCard(false)} /></section>
        )}

        {history.length > 0 && (
          <section className="card">
            <h3>History</h3>
            <div className="scroll"><table>
              <thead><tr><th>Date</th><th>Entered</th><th>Left</th><th>Time parked</th><th>Points</th></tr></thead>
              <tbody>{history.map((s) => (
                <tr key={s.id}>
                  <td>{fDate(s.entry)}</td>
                  <td>{fTime(s.entry)}</td>
                  <td>{s.exit ? fTime(s.exit) : "—"}</td>
                  <td>{s.exit ? fDur(s.exit - s.entry) : "—"}</td>
                  <td><span className="pill green">+{s.pointsEarned}</span></td>
                </tr>
              ))}</tbody>
            </table></div>
          </section>
        )}
      </main>
    </div>
  );
}
