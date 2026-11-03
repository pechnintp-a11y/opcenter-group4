// Netlify runtime for the app: login screen (Netlify Identity), a database client that
// speaks to /api (same shape the app already uses), and plain browser downloads.
import { getUser, login, signup, logout, oauthLogin, handleAuthCallback, getSettings, requestPasswordRecovery, updateUser } from '@netlify/identity';

const POLL_MS = 10000, POLL_HIDDEN_MS = 60000;
const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]));
const clone = x => x == null ? x : JSON.parse(JSON.stringify(x));

// ---------- API ----------
async function api(route, body){
  let r;
  try { r = await fetch('/api/' + route, { method: body ? 'POST' : 'GET', credentials:'same-origin', headers: body ? { 'content-type':'application/json' } : {}, body: body ? JSON.stringify(body) : undefined }); }
  catch (e){ throw { code:'unavailable' }; }
  if (r.ok) return r.json();
  const code = r.status === 401 ? 'unauthenticated' : r.status === 403 ? 'invalid_argument' : r.status === 404 ? 'not_found' : r.status === 413 ? 'quota_exceeded' : r.status === 429 ? 'resource_exhausted' : 'unavailable';
  if (r.status === 401) sessionLost();
  throw { code };
}
let lostShown = false;
function sessionLost(){ if (lostShown) return; lostShown = true; setTimeout(() => location.reload(), 600); }

// ---------- database client (doc / collection / onSnapshot) ----------
const subs = new Map(); let seq = 0; const revs = {}; let timer = null, inflight = null, pending = false;
const colOf = path => String(path).split('/')[0];
function snapDoc(id, data){ return { id, exists: data != null, data: () => clone(data), metadata:{ fromCache:false, hasPendingWrites:false } }; }
function snapCol(docs){ const ds = docs.map(d => snapDoc(d.id, d.data)); return { docs: ds, size: ds.length, empty: !ds.length, docChanges: () => [], metadata:{} }; }
function deliver(sub, res){
  if (!res || res.error){ if (sub.err) sub.err({ code:'unavailable', message: res && res.error }); return; }
  try { sub.cb(sub.q.kind === 'doc' ? snapDoc(res.id, res.exists ? res.data : null) : snapCol(res.docs || [])); } catch (e){ console.warn(e); }
}
async function sync(forceCols){
  if (inflight){ pending = true; return inflight; }
  const list = [...subs.values()];
  if (!list.length) return;
  const queries = list.map(s => Object.assign({ id: s.id, force: s.fresh || (forceCols && forceCols.has(colOf(s.q.path))) }, s.q));
  inflight = api('sync', { queries, revs }).then(out => {
    Object.assign(revs, out.revs || {});
    list.forEach(s => { if (out.results && s.id in out.results){ s.fresh = false; deliver(s, out.results[s.id]); } });
  }).catch(e => { list.forEach(s => s.err && s.err(e)); }).finally(() => { inflight = null; if (pending){ pending = false; sync(); } });
  return inflight;
}
let kick = null;
function soon(forceCols){ clearTimeout(kick); kick = setTimeout(() => sync(forceCols), 25); }
function schedulePoll(){ clearTimeout(timer); timer = setTimeout(async () => { await sync(); schedulePoll(); }, document.hidden ? POLL_HIDDEN_MS : POLL_MS); }
document.addEventListener('visibilitychange', () => { if (!document.hidden){ sync(); schedulePoll(); } });
window.addEventListener('focus', () => sync());

function subscribe(q, cb, err){
  const id = 's' + (++seq), sub = { id, q, cb, err, fresh: true };
  subs.set(id, sub); soon(); schedulePoll();
  return () => subs.delete(id);
}
async function write(op, path, data){
  const out = await api('write', { op, path, data });
  soon(new Set([out.col]));
  return out;
}
function docRef(path){
  return {
    id: path.split('/').pop(), path,
    get: async () => { const out = await api('sync', { queries:[{ id:'g', kind:'doc', path, force:true }], revs:{} }); const r = out.results.g; return snapDoc(r.id, r.exists ? r.data : null); },
    set: data => write('set', path, clone(data)).then(() => undefined),
    update: data => write('update', path, clone(data)).then(() => undefined),
    delete: () => write('delete', path).then(() => undefined),
    onSnapshot: (cb, err) => subscribe({ kind:'doc', path }, cb, err)
  };
}
function colRef(path, q = {}){
  const query = () => Object.assign({ kind:'col', path }, q);
  return {
    path,
    doc: id => docRef(path + '/' + (id || (Date.now().toString(36) + Math.random().toString(36).slice(2, 8)))),
    add: async data => { const out = await write('add', path, clone(data)); return docRef(path + '/' + out.id); },
    where: (f, op, v) => colRef(path, Object.assign({}, q, { where:[f, op, v] })),
    orderBy: (f, dir) => colRef(path, Object.assign({}, q, { orderBy:[f, dir || 'asc'] })),
    limit: n => colRef(path, Object.assign({}, q, { limit:n })),
    get: async () => { const out = await api('sync', { queries:[Object.assign({ id:'g', force:true }, query())], revs:{} }); return snapCol(out.results.g.docs || []); },
    onSnapshot: (cb, err) => subscribe(query(), cb, err)
  };
}
const db = { doc: docRef, collection: p => colRef(p) };

// ---------- downloads: a normal browser download ----------
const downloads = { save: async ({ filename, data }) => {
  const blob = data instanceof Blob ? data : new Blob([data], { type: /\.csv$/i.test(filename) ? 'text/csv;charset=utf-8' : 'application/octet-stream' });
  const url = URL.createObjectURL(blob), a = document.createElement('a');
  a.href = url; a.download = filename; document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30000);
  return { status:'saved' };
} };

// ---------- user ----------
let ME = null;
const user = {
  me: async () => ({ id: ME.user.id, name: ME.user.name || (ME.approval && ME.approval.name) || ME.user.email, email: ME.user.email, avatarUrl: ME.user.avatar || '', isOwner: ME.isAdmin, canEdit: ME.isAdmin }),
  id: async () => ME.user.id,
  can: async () => true,
  profiles: async ids => (await api('profiles', { ids:[].concat(ids) })).profiles || {}
};

window.claude = { use: async name => ({ db, user, downloads })[name] || null };
window.NF = {
  email: () => ME && ME.user.email,
  logout: async () => { try { await logout(); } catch (e){} document.cookie = 'nf_jwt=; path=/; expires=Thu, 01 Jan 1970 00:00:00 GMT'; location.replace(location.pathname); }
};

// ---------- login screen ----------
const ERR = m => {
  const s = String(m || '').toLowerCase();
  if (s.includes('invalid') && (s.includes('password') || s.includes('grant') || s.includes('credentials'))) return 'อีเมลหรือรหัสผ่านไม่ถูกต้อง';
  if (s.includes('not confirmed') || s.includes('email not confirmed')) return 'ยังไม่ได้ยืนยันอีเมล กรุณากดลิงก์ยืนยันในอีเมลก่อน';
  if (s.includes('already') && s.includes('registered')) return 'อีเมลนี้สมัครไว้แล้ว ให้เข้าสู่ระบบ หรือกด “ลืมรหัสผ่าน”';
  if (s.includes('password') && (s.includes('short') || s.includes('length') || s.includes('least'))) return 'รหัสผ่านสั้นเกินไป (อย่างน้อย 8 ตัวอักษร)';
  if (s.includes('signup') && s.includes('disabled')) return 'ระบบปิดการสมัครด้วยตนเอง กรุณาขอคำเชิญจากผู้ดูแล';
  if (s.includes('network') || s.includes('fetch')) return 'เชื่อมต่อไม่สำเร็จ ตรวจสอบอินเทอร์เน็ตแล้วลองใหม่';
  return 'ทำรายการไม่สำเร็จ ' + (m ? '(' + m + ')' : '') ;
};
const G_ICON = '<svg viewBox="0 0 48 48" width="20" height="20" aria-hidden="true"><path fill="#FFC107" d="M43.6 20.5H42V20H24v8h11.3C33.7 32.7 29.2 36 24 36c-6.6 0-12-5.4-12-12s5.4-12 12-12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34 6.1 29.3 4 24 4 12.9 4 4 12.9 4 24s8.9 20 20 20 20-8.9 20-20c0-1.3-.1-2.4-.4-3.5z"/><path fill="#FF3D00" d="m6.3 14.7 6.6 4.8C14.7 15.1 19 12 24 12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34 6.1 29.3 4 24 4 16.3 4 9.7 8.3 6.3 14.7z"/><path fill="#4CAF50" d="M24 44c5.2 0 9.9-2 13.4-5.2l-6.2-5.2C29.2 35.1 26.7 36 24 36c-5.2 0-9.6-3.3-11.3-7.9l-6.5 5C9.5 39.6 16.2 44 24 44z"/><path fill="#1976D2" d="M43.6 20.5H42V20H24v8h11.3c-.8 2.2-2.2 4.2-4.1 5.6l6.2 5.2C37 39.2 44 34 44 24c0-1.3-.1-2.4-.4-3.5z"/></svg>';

function gateHTML(state){
  const t = document.title || 'ศูนย์ปฏิบัติการกลุ่มจังหวัด 4';
  return `<div class="gate"><div class="gate-card card">
    <img class="gate-logo" src="img/moj-logo.png" alt="ตรากระทรวงยุติธรรม" width="84" height="84">
    <div class="gate-h"><h1>${esc(t)}</h1><p>ระบบรายงานกลุ่มจังหวัดภาคตะวันออก 2 · สำนักงานปลัดกระทรวงยุติธรรม</p></div>
    <div id="gate-body">${state}</div></div>
    <p class="gate-foot">ข้อมูลของระบบนี้ใช้เฉพาะงานราชการ เจ้าหน้าที่ต้องลงทะเบียนสังกัดและได้รับอนุมัติก่อนส่งข้อมูล</p></div>`;
}
function formHTML(mode, settings){
  const google = !settings || (settings.providers && settings.providers.google);
  const emailOn = !settings || !settings.providers || settings.providers.email !== false;
  const allowSignup = !settings || !settings.disableSignup;
  if (mode === 'recover-set') return `<form class="form" id="g-form" data-mode="recover-set"><h2>ตั้งรหัสผ่านใหม่</h2>
    <label class="fld"><span>รหัสผ่านใหม่ (อย่างน้อย 8 ตัวอักษร)</span><input type="password" id="g-pass" autocomplete="new-password" minlength="8" required></label>
    <button class="btn primary big" type="submit">บันทึกรหัสผ่านและเข้าสู่ระบบ</button><p class="gate-msg" id="g-msg" role="alert"></p></form>`;
  if (mode === 'forgot') return `<form class="form" id="g-form" data-mode="forgot"><h2>ลืมรหัสผ่าน</h2><p class="small">กรอกอีเมลที่ใช้สมัคร ระบบจะส่งลิงก์ตั้งรหัสผ่านใหม่ไปให้</p>
    <label class="fld"><span>อีเมล</span><input type="email" id="g-email" autocomplete="email" required></label>
    <button class="btn primary big" type="submit">ส่งลิงก์ตั้งรหัสผ่านใหม่</button><p class="gate-msg" id="g-msg" role="alert"></p>
    <button class="btn ghost" type="button" data-g="login">กลับไปหน้าเข้าสู่ระบบ</button></form>`;
  const signupMode = mode === 'signup';
  if (!emailOn) return google ? `<button class="btn big g-google" type="button" data-g="google">${G_ICON}เข้าสู่ระบบด้วยบัญชี Google</button>` : '<p>ยังไม่ได้เปิดวิธีเข้าสู่ระบบ กรุณาแจ้งผู้ดูแล</p>';
  return `${google ? `<button class="btn big g-google" type="button" data-g="google">${G_ICON}เข้าสู่ระบบด้วยบัญชี Google</button><div class="gate-or"><span>หรือใช้อีเมล</span></div>` : ''}
    ${allowSignup ? `<div class="seg-tabs gate-tabs" role="tablist"><button type="button" data-g="login" aria-pressed="${!signupMode}">เข้าสู่ระบบ</button><button type="button" data-g="signup" aria-pressed="${signupMode}">สมัครใช้งาน</button></div>` : ''}
    <form class="form" id="g-form" data-mode="${signupMode ? 'signup' : 'login'}">
      ${signupMode ? '<label class="fld"><span>ชื่อ-นามสกุล</span><input type="text" id="g-name" autocomplete="name" required></label>' : ''}
      <label class="fld"><span>อีเมล</span><input type="email" id="g-email" autocomplete="email" required></label>
      <label class="fld"><span>รหัสผ่าน${signupMode ? ' (อย่างน้อย 8 ตัวอักษร)' : ''}</span><input type="password" id="g-pass" autocomplete="${signupMode ? 'new-password' : 'current-password'}" ${signupMode ? 'minlength="8"' : ''} required></label>
      <button class="btn primary big" type="submit">${signupMode ? 'สมัครใช้งาน' : 'เข้าสู่ระบบ'}</button>
      <p class="gate-msg" id="g-msg" role="alert"></p>
      ${signupMode ? '' : '<button class="btn ghost" type="button" data-g="forgot">ลืมรหัสผ่าน?</button>'}
    </form>`;
}
function showGate(settings, mode, note){
  document.body.classList.add('gated');
  let root = document.getElementById('gate-root');
  if (!root){ root = document.createElement('div'); root.id = 'gate-root'; document.body.appendChild(root); }
  root.innerHTML = gateHTML((note ? `<div class="notice ${note.kind || 'info'}"><span class="grow">${note.html}</span></div>` : '') + formHTML(mode, settings));
  return new Promise(resolve => {
    const msg = t => { const m = document.getElementById('g-msg'); if (m) m.textContent = t || ''; };
    root.onclick = ev => {
      const b = ev.target.closest('[data-g]'); if (!b) return;
      const g = b.dataset.g;
      if (g === 'google'){ try { oauthLogin('google'); } catch (e){} return; }
      showGate(settings, g).then(resolve);
    };
    root.onsubmit = async ev => {
      ev.preventDefault();
      const f = ev.target, mode2 = f.dataset.mode, btn = f.querySelector('button[type=submit]');
      const email = (document.getElementById('g-email') || {}).value, pass = (document.getElementById('g-pass') || {}).value;
      btn.disabled = true; msg('กำลังดำเนินการ…');
      try {
        if (mode2 === 'login'){ await login(email.trim(), pass); resolve(true); }
        else if (mode2 === 'signup'){
          const u = await signup(email.trim(), pass, { full_name: document.getElementById('g-name').value.trim() });
          if (u && u.confirmedAt){ resolve(true); return; }
          showGate(settings, 'login', { kind:'good', html:`ส่งอีเมลยืนยันไปที่ <b>${esc(email)}</b> แล้ว กดลิงก์ในอีเมล (ตรวจในกล่องจดหมายขยะด้วย) แล้วกลับมาเข้าสู่ระบบ` }).then(resolve);
        } else if (mode2 === 'forgot'){
          await requestPasswordRecovery(email.trim());
          showGate(settings, 'login', { kind:'good', html:`ถ้ามีบัญชีของ <b>${esc(email)}</b> ระบบได้ส่งลิงก์ตั้งรหัสผ่านใหม่ไปทางอีเมลแล้ว` }).then(resolve);
        } else if (mode2 === 'recover-set'){ await updateUser({ password: pass }); resolve(true); }
      } catch (e){ btn.disabled = false; msg(ERR(e && (e.message || e.error_description || e.msg))); }
    };
  });
}
function clearHash(){ try { history.replaceState(null, '', location.pathname + location.search); } catch (e){} }

async function signedIn(){
  try { ME = await api('me'); return true; } catch (e){ ME = null; return false; }
}
window.__beforeBoot = async () => {
  let settings = null, cb = null, cbErr = null;
  const h = location.hash || '';
  if (/(access_token|confirmation_token|recovery_token|invite_token|email_change_token|error)=/.test(h)){
    try { cb = await handleAuthCallback(); } catch (e){ cbErr = e; }
    clearHash();
  }
  try { settings = await getSettings(); }
  catch (e){
    showGate(null, 'login', { kind:'bad', html:'ยังเปิดระบบล็อกอินไม่ได้ ผู้ดูแลต้องเปิด <b>Netlify Identity</b> ของโปรเจกต์นี้ก่อน (Project configuration › Identity › Enable Identity)' });
    await new Promise(() => {});
  }
  if (cb && cb.type === 'recovery') await showGate(settings, 'recover-set');
  let u = await getUser();
  if (!u || !(await signedIn())){
    const note = cbErr ? { kind:'bad', html: esc(ERR(cbErr.message)) } : cb && cb.type === 'confirmation' ? { kind:'good', html:'ยืนยันอีเมลเรียบร้อย เข้าสู่ระบบได้เลย' } : null;
    for (;;){
      await showGate(settings, 'login', note);
      if (await signedIn()) break;
    }
  }
  const root = document.getElementById('gate-root'); if (root) root.remove();
  document.body.classList.remove('gated');
};
