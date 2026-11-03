// Data API for ศูนย์ปฏิบัติการกลุ่มจังหวัด 4
// Login: Netlify Identity (Google or email). Storage: Netlify Blobs, one key per document.
// Every read and write is checked here, on the server, against the same access rules
// the claude.ai version used (admins, approved reporters per office, coordination centre).
import { getStore } from '@netlify/blobs';
import { getUser } from '@netlify/identity';

export const config = { path: '/api/*' };

const COLS = new Set(['config', 'group', 'offices', 'approvals', 'registrations', 'activities', 'deadlines', 'logs', 'visits']);
const SEG = /^[A-Za-z0-9_\-.:@]{1,160}$/;
const MAX_BODY = 600 * 1024;

const store = () => getStore({ name: 'opcenter', consistency: 'strong' });
const reply = (data, status = 200) => Response.json(data, { status, headers: { 'cache-control': 'no-store' } });
const fail = (code, status) => reply({ error: code }, status);
const env = k => (globalThis.Netlify && Netlify.env.get(k)) || process.env[k] || '';
const adminEmails = () => env('ADMIN_EMAILS').toLowerCase().split(/[\s,;]+/).filter(Boolean);
const isObj = v => v && typeof v === 'object' && !Array.isArray(v);
const newId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
const docKey = (col, id) => `d/${col}/${id}`;

function docPath(p){
  const parts = String(p || '').split('/');
  return parts.length === 2 && COLS.has(parts[0]) && SEG.test(parts[1]) ? { col: parts[0], id: parts[1] } : null;
}
function colPath(p){ const c = String(p || ''); return COLS.has(c) ? { col: c } : null; }

// ---- who is calling (cached per token for a minute) ----
const userCache = new Map();
async function caller(){
  const jwt = globalThis.Netlify?.context?.cookies?.get('nf_jwt') || '';
  const hit = jwt && userCache.get(jwt);
  let u = hit && hit.until > Date.now() ? hit.user : null;
  if (!u){
    u = await getUser();
    if (!u) return null;
    if (jwt){ userCache.set(jwt, { user: u, until: Date.now() + 60000 }); if (userCache.size > 500) userCache.clear(); }
  }
  const email = String(u.email || '').toLowerCase();
  const s = store();
  const ap = await s.get(docKey('approvals', u.id), { type: 'json' });
  return {
    id: u.id, email,
    name: u.name || (u.userMetadata && (u.userMetadata.full_name || u.userMetadata.name)) || '',
    avatar: u.pictureUrl || (u.userMetadata && u.userMetadata.avatar_url) || '',
    isAdmin: adminEmails().includes(email) || (u.roles || []).includes('admin'),
    ap: ap || null
  };
}

// ---- access rules ----
function canRead(a, col, id){
  if (col === 'registrations') return a.isAdmin || id === a.id;
  return true;
}
function canWrite(a, op, col, id, data){
  const ap = a.ap, center = a.isAdmin || (ap && ap.role === 'center'), approved = a.isAdmin || !!ap;
  switch (col){
    case 'config': return a.isAdmin && id === 'group';
    case 'approvals': return a.isAdmin && op !== 'add';
    case 'registrations': return op !== 'add' && (id === a.id || (a.isAdmin && op === 'delete'));
    case 'offices': return op !== 'add' && (a.isAdmin || (!!ap && ap.office === id));
    case 'group': return center && id === 'report' && op !== 'add';
    case 'activities': return center;
    case 'deadlines': return center || (approved && op === 'update' && isObj(data) && Object.keys(data).every(k => k === 'sent'));
    case 'logs': return approved && op === 'add';
    case 'visits': {
      if (op === 'add') return false;
      const m = /^([a-z]{2,4})_(\d{4}-\d{2}-\d{2})_(.+)$/.exec(id || ''); if (!m) return false;
      return a.isAdmin || (!!ap && ap.office === m[1] && m[3] === a.id);
    }
  }
  return false;
}

// ---- change markers: one small key per collection, read by /api/sync ----
async function bump(s, col){ const v = newId(); await s.set('r/' + col, v); return v; }
async function revsOf(s, cols){ const out = {}; await Promise.all(cols.map(async c => { out[c] = (await s.get('r/' + c)) || '0'; })); return out; }

function mergeDoc(old, patch){
  const out = Object.assign({}, old);
  for (const [k, v] of Object.entries(patch)){
    out[k] = (k === 'meta' || k === 'sent') && isObj(v) && isObj(old[k]) ? deepMerge(old[k], v) : v;
  }
  return out;
}
function deepMerge(a, b){ const o = Object.assign({}, a); for (const [k, v] of Object.entries(b)) o[k] = isObj(v) && isObj(a[k]) ? deepMerge(a[k], v) : v; return o; }

async function runQuery(s, a, q){
  if (q.kind === 'doc'){
    const P = docPath(q.path); if (!P) return { error: 'bad_path' };
    if (!canRead(a, P.col, P.id)) return { exists: false, id: P.id, data: null };
    const d = await s.get(docKey(P.col, P.id), { type: 'json' });
    return { exists: d != null, id: P.id, data: d };
  }
  const P = colPath(q.path); if (!P) return { error: 'bad_path' };
  if (P.col === 'registrations' && !a.isAdmin){
    const d = await s.get(docKey('registrations', a.id), { type: 'json' });
    return { docs: d ? [{ id: a.id, data: d }] : [] };
  }
  const prefix = `d/${P.col}/`;
  let keys = (await s.list({ prefix })).blobs.map(b => b.key);
  const where = Array.isArray(q.where) ? q.where : null;
  if (where && P.col === 'visits' && where[0] === 'date') keys = keys.filter(k => k.includes(`_${where[2]}_`));
  if (P.col === 'logs'){ keys.sort().reverse(); keys = keys.slice(0, Math.min(Number(q.limit) || 100, 300)); }
  let docs = (await Promise.all(keys.map(async k => ({ id: k.slice(prefix.length), data: await s.get(k, { type: 'json' }) })))).filter(d => d.data != null);
  if (where && where[1] === '==') docs = docs.filter(d => d.data[where[0]] === where[2]);
  if (Array.isArray(q.orderBy)){ const [f, dir] = q.orderBy; docs.sort((x, y) => String(x.data[f] ?? '').localeCompare(String(y.data[f] ?? '')) * (dir === 'desc' ? -1 : 1)); }
  if (q.limit) docs = docs.slice(0, Number(q.limit));
  return { docs };
}

// first admin visit: put the official deadlines and default settings in place
async function seedIfNeeded(s, origin){
  if (await s.get('meta/seeded')) return;
  const now = new Date().toISOString();
  if (!(await s.get(docKey('config', 'group')))) await s.setJSON(docKey('config', 'group'), {
    appName: 'ศูนย์ปฏิบัติการกลุ่มจังหวัด 4', label: 'กลุ่มจังหวัดภาคตะวันออก 2', center: 'pri', members: ['pri', 'nyk', 'skw', 'cti', 'trt'],
    fy: 2570, years: [2567, 2568, 2569, 2570], budget: { total: 85000, t1: 61000, t2: 24000 }, month: 'กันยายน 2570', appLink: origin, updatedAt: now });
  const dl = {
    'official-budget-2570': { date: '2027-06-30', kind: 'budget', offices: [], official: true, remind: [14, 7, 3, 1, 0], sent: {}, time: '', updatedAt: now,
      title: 'เบิกจ่ายงบประมาณการขับเคลื่อนการบริหารงานแบบกลุ่มจังหวัดให้แล้วเสร็จ',
      note: 'หากมีงบประมาณเหลือจ่าย ให้แจ้งส่งคืนกองประสานราชการยุติธรรมจังหวัดทันที (ข้อ 6.2 กรอบค่าใช้จ่ายฯ)' },
    'official-report-2570': { date: '2027-09-30', kind: 'report', offices: [], official: true, remind: [14, 7, 3, 1, 0], sent: {}, time: '', updatedAt: now,
      title: 'ส่งรายงานผลการปฏิบัติราชการของกลุ่มจังหวัด ปีงบประมาณ 2570 (เอกสารหมายเลข 2) ถึงกองประสานราชการยุติธรรมจังหวัด',
      note: 'ศูนย์ปฏิบัติการจัดทำรายงานจากข้อมูลที่ สยจ. ทุกแห่งส่งในระบบ (ข้อ 5.2.5 กรอบค่าใช้จ่ายฯ)' }
  };
  for (const [id, d] of Object.entries(dl)) if (!(await s.get(docKey('deadlines', id)))) await s.setJSON(docKey('deadlines', id), d);
  await bump(s, 'config'); await bump(s, 'deadlines');
  await s.set('meta/seeded', now);
}

export default async (req, context) => {
  const url = new URL(req.url);
  const route = url.pathname.replace(/^\/api\/?/, '');
  if (req.method === 'POST' && req.headers.get('origin') && req.headers.get('origin') !== url.origin) return fail('bad_origin', 403);
  const a = await caller().catch(() => null);
  if (!a) return fail('unauthenticated', 401);
  const s = store();
  let body = {};
  if (req.method === 'POST'){
    const text = await req.text();
    if (text.length > MAX_BODY) return fail('too_large', 413);
    try { body = text ? JSON.parse(text) : {}; } catch (e){ return fail('bad_json', 400); }
  }
  try {
    if (route === 'me'){
      if (a.isAdmin) await seedIfNeeded(s, url.origin);
      return reply({ user: { id: a.id, email: a.email, name: a.name, avatar: a.avatar }, isAdmin: a.isAdmin, approval: a.ap });
    }
    if (route === 'sync' && req.method === 'POST'){
      const qs = Array.isArray(body.queries) ? body.queries.slice(0, 40) : [];
      const colOf = q => String(q.path || '').split('/')[0];
      const cols = [...new Set(qs.map(colOf).filter(c => COLS.has(c)))];
      const revs = await revsOf(s, cols), known = isObj(body.revs) ? body.revs : {};
      const results = {};
      await Promise.all(qs.map(async q => { const c = colOf(q); if (q.force || known[c] !== revs[c]) results[q.id] = await runQuery(s, a, q); }));
      return reply({ revs, results });
    }
    if (route === 'write' && req.method === 'POST'){
      const op = body.op, data = body.data;
      if (!['set', 'update', 'delete', 'add'].includes(op)) return fail('bad_op', 400);
      let P;
      if (op === 'add'){ const C = colPath(body.path); if (!C) return fail('bad_path', 400); P = { col: C.col, id: (C.col === 'logs' ? new Date().toISOString().replace(/[-:.TZ]/g, '') + '_' : '') + newId() }; }
      else { P = docPath(body.path); if (!P) return fail('bad_path', 400); }
      if (op !== 'delete' && !isObj(data)) return fail('bad_data', 400);
      if (!canWrite(a, op, P.col, P.id, data)) return fail('forbidden', 403);
      const key = docKey(P.col, P.id);
      let doc = data;
      if (P.col === 'logs') doc = Object.assign({}, data, { by: a.id });
      if (op === 'delete') await s.delete(key);
      else if (op === 'update'){
        const old = await s.get(key, { type: 'json' }); if (old == null) return fail('not_found', 404);
        await s.setJSON(key, mergeDoc(old, data));
      } else await s.setJSON(key, doc);
      const rev = await bump(s, P.col);
      return reply({ ok: true, id: P.id, col: P.col, rev });
    }
    if (route === 'profiles' && req.method === 'POST'){
      const ids = Array.isArray(body.ids) ? body.ids.filter(x => SEG.test(String(x))).slice(0, 64) : [];
      const out = {};
      await Promise.all(ids.map(async id => {
        const ap = await s.get(docKey('approvals', id), { type: 'json' });
        const rg = !ap && (a.isAdmin || id === a.id) ? await s.get(docKey('registrations', id), { type: 'json' }) : null;
        const n = (ap && ap.name) || (rg && rg.name) || (id === a.id ? a.name : '');
        if (n) out[id] = { id, name: n };
      }));
      return reply({ profiles: out });
    }
    return fail('not_found', 404);
  } catch (e){
    console.error('api error', route, e);
    return fail('server_error', 500);
  }
};
