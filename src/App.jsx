import { useEffect, useState } from "react";
import { supabase } from "./supabase";
import { GateIcon } from "./ui";
import UserPortal from "./UserPortal";
import AdminDashboard from "./AdminDashboard";

const ERR = {
  invalid_credentials: "Wrong email or password.",
  user_already_exists: "That email is already registered.",
  weak_password: "Password must be at least 6 characters.",
  email_address_invalid: "That email address isn’t valid.",
  over_email_send_rate_limit: "Too many attempts. Try again in a minute.",
  user_not_found: "No account with that email.",
  same_password: "That’s already your password.",
};
const friendly = (x) => ERR[x?.code] || x?.message || "Something went wrong. Try again.";

/* ---------- auth screen ---------- */
function AuthScreen() {
  const [mode, setMode] = useState("in");
  const [f, setF] = useState({ name: "", email: "", pass: "", pass2: "" });
  const [err, setErr] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [showPass, setShowPass] = useState(false);
  const up = mode === "up";
  const set1 = (k) => (e) => { setF({ ...f, [k]: e.target.value }); setErr(""); setNotice(""); };

  const submit = async (e) => {
    e.preventDefault(); setErr(""); setNotice("");
    if (up && f.pass !== f.pass2) return setErr("Passwords don’t match.");
    setBusy(true);
    try {
      if (up) {
        const { error } = await supabase.auth.signUp({
          email: f.email.trim(), password: f.pass,
          options: { data: { name: f.name.trim() || f.email.trim() } },
        });
        if (error) throw error;
      } else {
        const { error } = await supabase.auth.signInWithPassword({ email: f.email.trim(), password: f.pass });
        if (error) throw error;
      }
    } catch (x) { setErr(friendly(x)); }
    setBusy(false);
  };

  const forgotPassword = async () => {
    setErr(""); setNotice("");
    if (!f.email.trim()) return setErr("Enter your email above first, then click “Forgot password?”.");
    setBusy(true);
    try {
      const { error } = await supabase.auth.resetPasswordForEmail(f.email.trim());
      if (error) throw error;
      setNotice("Password reset email sent. Check your inbox.");
    } catch (x) { setErr(friendly(x)); }
    setBusy(false);
  };

  return (
    <div className="auth">
      <aside className="brand">
        <div className="logo"><GateIcon size={28} /> Crossing <em>Mall</em></div>
        <div className="brand-tag">SMART PARKING · ONE TAP AWAY</div>
        <h1>Tap in.<br />Gate's open.</h1>
        <p>Register your RFID card, tap it to park and tap again to leave. Admins watch every gate, car and bay update the moment it happens.</p>
        <ul>
          <li>Register your card once — no re-entering details</li>
          <li>Tap to enter, tap to leave — the barrier opens itself</li>
          <li>Earn points every visit, redeemable for a discount</li>
        </ul>
        <div className="brand-foot"><span /> Live at Crossing Mall</div>
      </aside>
      <main className="panel">
        <form className="auth-card" onSubmit={submit}>
          <div className="auth-heading">
            <span className="auth-kicker">PARKING OPERATIONS</span>
            <h2>{up ? "Create your account" : "Welcome back"}</h2>
            <p className="muted">{up ? "Sign up to register your RFID card and start earning points." : "Sign in to continue to your dashboard."}</p>
          </div>
          <div className="seg">
            <button type="button" className={!up ? "on" : ""} onClick={() => { setMode("in"); setErr(""); }}>Sign in</button>
            <button type="button" className={up ? "on" : ""} onClick={() => { setMode("up"); setErr(""); }}>Sign up</button>
          </div>
          {up && <label>Full name<input value={f.name} onChange={set1("name")} placeholder="Jane Doe" autoComplete="name" /></label>}
          <label>Email<input type="email" required value={f.email} onChange={set1("email")} placeholder="you@example.com" autoComplete="email" /></label>
          <label>
            <span className="label-row">Password{!up && <button type="button" className="link" onClick={forgotPassword} disabled={busy}>Forgot password?</button>}</span>
            <span className="pass-field">
              <input type={showPass ? "text" : "password"} required minLength={6} value={f.pass} onChange={set1("pass")} placeholder="Minimum 6 characters" autoComplete={up ? "new-password" : "current-password"} />
              <button type="button" className="pass-toggle" onClick={() => setShowPass((s) => !s)} aria-label={showPass ? "Hide password" : "Show password"}>{showPass ? "Hide" : "Show"}</button>
            </span>
          </label>
          {up && <label>Confirm password<input type={showPass ? "text" : "password"} required value={f.pass2} onChange={set1("pass2")} placeholder="Repeat password" autoComplete="new-password" /></label>}
          {up && <p className="hint">Check your inbox to confirm your email before signing in, if your project requires it.</p>}
          {err && <div className="err">{err}</div>}
          {notice && <div className="notice">{notice}</div>}
          <button className="btn primary wide" disabled={busy}>{busy ? "Please wait…" : up ? "Create account" : "Sign in"}</button>
        </form>
      </main>
    </div>
  );
}

/* ---------- root: admins get the control dashboard, everyone else the driver portal ---------- */
export default function App() {
  const [user, setUser] = useState(undefined);
  const [role, setRole] = useState(null);

  useEffect(() => {
    const loadUser = async (session) => {
      if (!session?.user) { setRole(null); setUser(null); return; }
      const { data: profile } = await supabase.from("profiles").select("name, role").eq("id", session.user.id).maybeSingle();
      setUser({
        uid: session.user.id,
        email: session.user.email,
        displayName: session.user.user_metadata?.name || profile?.name || null,
      });
      setRole(profile?.role === "admin" ? "admin" : "user");
    };
    supabase.auth.getSession().then(({ data }) => loadUser(data.session));
    const { data: sub } = supabase.auth.onAuthStateChange((_event, session) => loadUser(session));
    return () => sub.subscription.unsubscribe();
  }, []);

  if (user === undefined || (user && !role)) return <div className="splash"><GateIcon size={40} /></div>;
  if (!user) return <AuthScreen />;
  return role === "admin" ? <AdminDashboard key={user.uid} user={user} /> : <UserPortal key={user.uid} user={user} />;
}
