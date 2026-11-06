// Sign-in for the dashboard: Google or an emailed code, then a short-lived token for the Data API.
// The database decides who sees data: only emails on the approved list (schema/dash_api.sql).
export const AUTH_URL = 'https://ep-plain-king-bdcfq2ot.neonauth.c-8.us-east-2.aws.neon.tech/market_data/auth';
const SESSION_KEY = 'tag-market-session';

function storedSession() { try { return localStorage.getItem(SESSION_KEY); } catch (e) { return null; } }
function storeSession(v) { try { if (v) localStorage.setItem(SESSION_KEY, v); else localStorage.removeItem(SESSION_KEY); } catch (e) {} }

// credentials: include sends the session cookie. The bearer header covers browsers that block it as third-party.
async function call(path, { body } = {}) {
  const headers = {};
  if (body) headers['Content-Type'] = 'application/json';
  const session = storedSession();
  if (session) headers.Authorization = 'Bearer ' + session;
  const res = await fetch(AUTH_URL + path, {
    method: body ? 'POST' : 'GET', credentials: 'include', headers, body: body ? JSON.stringify(body) : undefined,
  });
  const issued = res.headers.get('set-auth-token');
  if (issued) storeSession(issued);
  let json = null;
  try { json = await res.json(); } catch (e) {}
  return { ok: res.ok, status: res.status, json };
}

let jwt = null, jwtExp = 0, pending = null;
function expiryOf(token) {
  try { return JSON.parse(atob(token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/'))).exp * 1000; } catch (e) { return 0; }
}
async function fetchToken() {
  const r = await call('/token');
  const token = r.ok && r.json && r.json.token;
  if (!token) return null;
  jwt = token; jwtExp = expiryOf(token);
  return jwt;
}

const STYLE = `
.tag-gate{position:fixed;inset:0;z-index:1000;display:flex;align-items:center;justify-content:center;padding:16px;
  background:var(--bg,#0b1622);color:var(--fg,#f2f4f7);font-family:var(--sans,ui-monospace,Menlo,monospace)}
.tag-gate form{width:100%;max-width:360px;padding:24px;border:1px solid var(--st4,#34465a);border-radius:8px;background:var(--panel,#13202e)}
.tag-gate h1{margin:0 0 6px;font-size:18px;font-weight:700}
.tag-gate p{margin:0 0 16px;font-size:13px;line-height:1.5;color:var(--fg-2,#b6c0cc)}
.tag-gate label{display:block;margin-bottom:6px;font-size:12px}
.tag-gate input{box-sizing:border-box;width:100%;padding:12px;margin-bottom:12px;font:inherit;font-size:16px;color:inherit;
  background:var(--bg,#0b1622);border:1px solid var(--st4,#34465a);border-radius:6px}
.tag-gate button{width:100%;padding:12px;font:inherit;font-size:14px;font-weight:700;cursor:pointer;color:#fff;
  background:var(--orange,#c8551b);border:0;border-radius:6px}
.tag-gate button:disabled{opacity:.6;cursor:default}
.tag-gate .google{margin-bottom:12px;color:inherit;background:transparent;border:1px solid var(--st4,#34465a)}
.tag-gate .or{margin:0 0 12px;font-size:12px;text-align:center}
.tag-gate .err{min-height:18px;margin:10px 0 0;color:var(--orange,#e0793f)}
`;

function showGate(message) {
  return new Promise(resolve => {
    if (!document.getElementById('tag-gate-style')) {
      const st = document.createElement('style'); st.id = 'tag-gate-style'; st.textContent = STYLE; document.head.appendChild(st);
    }
    const gate = document.createElement('div');
    gate.className = 'tag-gate';
    let email = '';
    const render = (step, err) => {
      gate.innerHTML = step === 'email'
        ? `<form><h1>Market Dashboard</h1><p>The Anton Group. Sign in with your approved email.</p>
           <button type="button" class="google">Continue with Google</button>
           <p class="or">or get a code by email</p>
           <label for="tag-email">Email</label><input id="tag-email" type="email" autocomplete="email" required>
           <button type="submit">Send code</button><p class="err"></p></form>`
        : `<form><h1>Check your email</h1><p>Enter the code sent to <span class="to"></span>. It comes from Neon Auth, so check junk mail if you don't see it.</p>
           <label for="tag-otp">Code</label><input id="tag-otp" inputmode="numeric" autocomplete="one-time-code" required>
           <button type="submit">Sign in</button><p class="err"></p></form>`;
      const to = gate.querySelector('.to');
      if (to) to.textContent = email;
      gate.querySelector('.err').textContent = err || '';
      const form = gate.querySelector('form'), input = form.querySelector('input');
      const btn = form.querySelector('button[type=submit]');
      const say = t => { gate.querySelector('.err').textContent = t; btn.disabled = false; };
      const google = form.querySelector('.google');
      if (google) google.onclick = async () => {
        google.disabled = true;
        try {
          const r = await call('/sign-in/social', { body: { provider: 'google', callbackURL: location.href } });
          if (r.ok && r.json && r.json.url) { location.href = r.json.url; return; }
          say((r.json && r.json.message) || 'Could not start Google sign-in.');
        } catch (e) { say('Could not reach the sign-in service. Check your connection.'); }
        google.disabled = false;
      };
      input.focus();
      form.onsubmit = async ev => {
        ev.preventDefault();
        btn.disabled = true;
        try {
          if (step === 'email') {
            const v = input.value.trim().toLowerCase();
            const r = await call('/email-otp/send-verification-otp', { body: { email: v, type: 'sign-in' } });
            if (!r.ok) return say((r.json && r.json.message) || 'Could not send the code. Try again.');
            email = v;
            render('otp');
          } else {
            const r = await call('/sign-in/email-otp', { body: { email, otp: input.value.trim() } });
            if (!r.ok) return say((r.json && r.json.message) || 'That code did not work.');
            if (r.json && r.json.token) storeSession(r.json.token);
            const token = await fetchToken();
            if (!token) return say('Signed in, but this browser blocked the session. Tell Alex which browser you are using.');
            gate.remove();
            resolve(token);
          }
        } catch (e) { say('Could not reach the sign-in service. Check your connection.'); }
      };
    };
    render('email', message);
    document.body.appendChild(gate);
  });
}

// A token for the Data API, asking the user to sign in if there is no session. force skips the cached token.
export function getToken({ force = false, message = '' } = {}) {
  if (!force && jwt && Date.now() < jwtExp - 30000) return Promise.resolve(jwt);
  if (!pending) {
    pending = (async () => {
      let token = null;
      if (!message) { try { token = await fetchToken(); } catch (e) {} }
      return token || showGate(message);
    })().finally(() => { pending = null; });
  }
  return pending;
}

export async function signOut() {
  try { await call('/sign-out', { body: {} }); } catch (e) {}
  jwt = null; jwtExp = 0; storeSession(null);
}
