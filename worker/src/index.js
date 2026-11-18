/* ══════════════════════════════════════════════════════════════════════════
   wordspark-api — the only server WordSpark has
   ══════════════════════════════════════════════════════════════════════════

   WordSpark works entirely on the learner's device and always will. This API
   exists for one thing the device cannot do by itself: let a teacher see
   whether their class is actually moving. Nothing else is worth a server.

   Two rules shaped every decision below, and they are not negotiable:

   1. The learners are minors. So there are no names, no emails, no phone
      numbers, no national IDs, no IP addresses and no answers stored here —
      only a nickname the learner picks, and counts. A teacher sees
      "نمر٧ · 25% · last active yesterday", and never learns who that is
      unless the learner tells them in the room.

   2. Opting in is a deliberate act. A learner who never types a class code
      never appears in this database, and the platform behaves exactly as it
      does today: offline, local, silent.

   There are no accounts and no passwords. A class has a short public code
   that learners type, and a long secret key that the teacher keeps. Knowing
   the key is what makes you the teacher of that class; knowing a learner id
   is what makes you that learner. That is the whole auth model, and it is
   deliberate: password reset flows need an email address, and an email
   address from a fourteen-year-old is exactly what this design refuses to
   hold.

   The honest cost of that: a teacher who loses the key cannot recover the
   class, and must start a new one. The dashboard says so before it hands the
   key over once.
*/

const CURRICULUM_TOTAL = 112;   // 42 stations + 16 grammar + 25 reading + 19 podcast + 10 conv
const EVENT_RETENTION_DAYS = 90;
const MAX_EVENTS_PER_SYNC = 50;
const MAX_BODY_BYTES = 8 * 1024;
const ALIAS_MAX = 16;
const TRACKS = ['stations', 'grammar', 'reading', 'podcast', 'conv'];
const EVENT_KINDS = new Set(['station', 'grammar', 'reading', 'podcast', 'conv']);

/* Codes a teenager reads off a whiteboard and types correctly the first time:
   no O/0, no I/1/L, no S/5, no U/V. 28^6 is ~481 million, and a class is
   capped at 60 learners, so guessing one to pollute it is not a realistic
   attack — and a polluted class is recoverable by the teacher anyway. */
const CODE_ALPHABET = '23456789ABCDEFGHJKMNPQRTWXYZ';
const CODE_LEN = 6;

// ── helpers ───────────────────────────────────────────────────────────────

const now = () => Math.floor(Date.now() / 1000);

function randomCode() {
  const bytes = crypto.getRandomValues(new Uint8Array(CODE_LEN));
  let out = '';
  for (const b of bytes) out += CODE_ALPHABET[b % CODE_ALPHABET.length];
  return out;
}

function randomKey() {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function allowedOrigins(env) {
  // Set ALLOWED_ORIGINS in the Worker's variables once the domain exists.
  // Until then these cover the published site and local testing.
  const fromEnv = (env.ALLOWED_ORIGINS || '')
    .split(',').map((s) => s.trim()).filter(Boolean);
  return fromEnv.length ? fromEnv : [
    'https://ara2026fat.github.io',
    'http://localhost:8799',
    'http://127.0.0.1:8799'
  ];
}

function corsHeaders(req, env) {
  const origin = req.headers.get('Origin') || '';
  const list = allowedOrigins(env);
  const ok = list.includes(origin);
  const h = {
    'Access-Control-Allow-Methods': 'GET,POST,DELETE,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type,X-Teacher-Key',
    'Access-Control-Max-Age': '86400',
    'Vary': 'Origin'
  };
  // An unlisted origin gets no CORS header at all rather than a wildcard, so
  // a page on another site cannot read a class roster out of a teacher's
  // browser. The request still fails closed in the browser, not here.
  if (ok) h['Access-Control-Allow-Origin'] = origin;
  return h;
}

function json(data, status, req, env) {
  return new Response(JSON.stringify(data), {
    status: status || 200,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      ...corsHeaders(req, env)
    }
  });
}

const ok  = (data, req, env) => json({ ok: true, ...data }, 200, req, env);
const err = (code, msg, status, req, env) =>
  json({ ok: false, error: code, message: msg }, status, req, env);

async function readBody(req) {
  const raw = await req.text();
  if (raw.length > MAX_BODY_BYTES) throw new Error('body_too_large');
  if (!raw) return {};
  try { return JSON.parse(raw); } catch (e) { throw new Error('bad_json'); }
}

// ── validation ────────────────────────────────────────────────────────────

const isCode = (v) =>
  typeof v === 'string' && v.length === CODE_LEN &&
  [...v].every((c) => CODE_ALPHABET.includes(c));

const isKey = (v) => typeof v === 'string' && /^[0-9a-f]{32}$/.test(v);

// Generated on the device; treated as that learner's bearer token, so it
// needs to be long enough that guessing one is pointless.
const isLearnerId = (v) => typeof v === 'string' && /^[A-Za-z0-9_-]{16,40}$/.test(v);

/* The app tells the learner not to use their real name, but a warning is not
   a control. These two checks are: an alias cannot contain an email address,
   and it cannot carry a run of digits long enough to be a phone number. They
   do not stop a determined learner from typing their own name — nothing can —
   but they stop the two mistakes that would actually matter if this database
   ever leaked. */
function aliasProblem(v) {
  if (typeof v !== 'string') return 'alias_required';
  const alias = v.trim();
  if (alias.length < 2) return 'alias_too_short';
  if (alias.length > ALIAS_MAX) return 'alias_too_long';
  if (alias.includes('@')) return 'alias_looks_like_email';
  if (/\d{7,}/.test(alias)) return 'alias_looks_like_phone';
  if (/[\u0000-\u001F\u007F<>]/.test(alias)) return 'alias_bad_chars';
  return null;
}

/* Counts only, each one bounded. An unbounded integer from a client ends up
   as a dashboard showing 4,000% and a teacher who stops trusting the tool. */
function cleanProgress(p) {
  if (!p || typeof p !== 'object') return null;
  const int = (v, max) => {
    const n = Math.floor(Number(v));
    if (!isFinite(n) || n < 0) return 0;
    return n > max ? max : n;
  };
  const total = int(p.total_items, 10000) || CURRICULUM_TOTAL;
  const out = {
    total_items: total,
    done_total: int(p.done_total, total),
    streak_days: int(p.streak_days, 3650)
  };
  for (const t of TRACKS) out[t] = int(p[t], total);
  // Recomputed here rather than trusted: the server states the percentage
  // its own numbers support, so the dashboard cannot be made to lie by a
  // modified client sending pct: 100 with done_total: 3.
  out.pct = total ? Math.floor((out.done_total / total) * 100) : 0;
  return out;
}

function cleanEvents(list) {
  if (!Array.isArray(list)) return [];
  const t = now();
  return list
    .filter((e) => e && EVENT_KINDS.has(e.kind))
    .slice(0, MAX_EVENTS_PER_SYNC)
    .map((e) => {
      let at = Math.floor(Number(e.at));
      // A device with a wrong clock would otherwise plant events in the far
      // future and sit permanently at the top of "recent activity".
      if (!isFinite(at) || at <= 0 || at > t + 3600) at = t;
      return { kind: e.kind, at };
    });
}

// ── routes ────────────────────────────────────────────────────────────────

/* POST /api/class  { label }  ->  { code, teacher_key }
   The key is returned exactly once and never again by any endpoint. */
async function createClass(req, env) {
  const body = await readBody(req);
  const label = String(body.label || '').trim().slice(0, 40) || 'صفّي';
  const t = now();

  // Six characters from a 28-letter alphabet collide rarely, but "rarely"
  // is not "never", and a collision would hand a teacher someone else's
  // class code. Retry on the UNIQUE violation instead of hoping.
  for (let attempt = 0; attempt < 6; attempt++) {
    const code = randomCode();
    const key = randomKey();
    try {
      await env.DB.prepare(
        `INSERT INTO classes (code,label,teacher_key,created_at,last_seen_at)
         VALUES (?,?,?,?,?)`
      ).bind(code, label, key, t, t).run();
      return ok({ code, teacher_key: key, label }, req, env);
    } catch (e) {
      if (!String(e.message || '').includes('UNIQUE')) throw e;
    }
  }
  return err('code_exhausted', 'لم نتمكّن من توليد رمز فصل، أعد المحاولة', 503, req, env);
}

/* GET /api/class?code=XXXXXX  ->  { label, learners }
   Public on purpose: a learner typing a code should be told whether it is
   real and what it is called before they join. It returns a count, never a
   roster — the roster needs the teacher key. */
async function peekClass(req, env, url) {
  const code = String(url.searchParams.get('code') || '').toUpperCase();
  if (!isCode(code)) return err('bad_code', 'رمز الفصل غير صحيح', 400, req, env);

  const row = await env.DB.prepare(
    `SELECT c.label, c.archived, c.max_learners,
            (SELECT COUNT(*) FROM learners l
              WHERE l.class_code = c.code AND l.removed = 0) AS learners
       FROM classes c WHERE c.code = ?`
  ).bind(code).first();

  if (!row) return err('no_class', 'لا يوجد فصل بهذا الرمز', 404, req, env);
  if (row.archived) return err('archived', 'هذا الفصل مُغلق', 410, req, env);
  return ok({ label: row.label, learners: row.learners, full: row.learners >= row.max_learners }, req, env);
}

/* POST /api/join  { code, alias, learner_id }
   Idempotent: the same learner_id re-joining just updates its alias, so a
   learner who retypes the code does not become a second row. */
async function joinClass(req, env) {
  const b = await readBody(req);
  const code = String(b.code || '').toUpperCase();
  const alias = String(b.alias || '').trim();
  const id = b.learner_id;

  if (!isCode(code)) return err('bad_code', 'رمز الفصل غير صحيح', 400, req, env);
  if (!isLearnerId(id)) return err('bad_learner', 'معرّف الجهاز غير صالح', 400, req, env);
  const aProblem = aliasProblem(alias);
  if (aProblem) return err(aProblem, aliasMessage(aProblem), 400, req, env);

  const cls = await env.DB.prepare(
    `SELECT code, label, archived, max_learners FROM classes WHERE code = ?`
  ).bind(code).first();
  if (!cls) return err('no_class', 'لا يوجد فصل بهذا الرمز', 404, req, env);
  if (cls.archived) return err('archived', 'هذا الفصل مُغلق', 410, req, env);

  const existing = await env.DB.prepare(
    `SELECT id, class_code FROM learners WHERE id = ?`
  ).bind(id).first();

  // The cap is checked only for a genuinely new learner. Counting an existing
  // one against it would lock a returning learner out of a full class.
  if (!existing) {
    const { c } = await env.DB.prepare(
      `SELECT COUNT(*) AS c FROM learners WHERE class_code = ? AND removed = 0`
    ).bind(code).first();
    if (c >= cls.max_learners) {
      return err('class_full', 'الفصل مكتمل، راجع معلّمك', 409, req, env);
    }
  }

  const t = now();
  try {
    await env.DB.prepare(
      `INSERT INTO learners (id,class_code,alias,joined_at,last_sync_at,removed)
       VALUES (?,?,?,?,?,0)
       ON CONFLICT(id) DO UPDATE SET
         class_code = excluded.class_code,
         alias      = excluded.alias,
         removed    = 0`
    ).bind(id, code, alias, t, t).run();
  } catch (e) {
    if (String(e.message || '').includes('UNIQUE')) {
      return err('alias_taken', 'هذا الاسم مستخدم في الفصل، اختر غيره', 409, req, env);
    }
    throw e;
  }
  return ok({ code, alias, label: cls.label }, req, env);
}

/* POST /api/sync  { learner_id, progress, events? }
   The learner id is the only credential, which is why it has to be long and
   device-generated. One row per learner, overwritten; the event log is
   appended to and trimmed. */
async function sync(req, env) {
  const b = await readBody(req);
  const id = b.learner_id;
  if (!isLearnerId(id)) return err('bad_learner', 'معرّف الجهاز غير صالح', 400, req, env);

  const learner = await env.DB.prepare(
    `SELECT id, class_code, removed FROM learners WHERE id = ?`
  ).bind(id).first();
  if (!learner) return err('not_joined', 'لم تنضم إلى فصل بعد', 404, req, env);
  // A removed learner is told plainly instead of syncing into a void: their
  // own data is still on their device and untouched.
  if (learner.removed) return err('removed', 'أزال معلّمك هذا الجهاز من الفصل', 410, req, env);

  const p = cleanProgress(b.progress);
  if (!p) return err('bad_progress', 'بيانات التقدّم غير صالحة', 400, req, env);
  const events = cleanEvents(b.events);
  const t = now();

  const stmts = [
    env.DB.prepare(
      `INSERT INTO progress (learner_id,pct,done_total,total_items,
                             stations,grammar,reading,podcast,conv,
                             streak_days,updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?)
       ON CONFLICT(learner_id) DO UPDATE SET
         pct=excluded.pct, done_total=excluded.done_total,
         total_items=excluded.total_items, stations=excluded.stations,
         grammar=excluded.grammar, reading=excluded.reading,
         podcast=excluded.podcast, conv=excluded.conv,
         streak_days=excluded.streak_days, updated_at=excluded.updated_at`
    ).bind(id, p.pct, p.done_total, p.total_items, p.stations, p.grammar,
           p.reading, p.podcast, p.conv, p.streak_days, t),
    env.DB.prepare(`UPDATE learners SET last_sync_at = ? WHERE id = ?`).bind(t, id)
  ];
  for (const e of events) {
    stmts.push(env.DB.prepare(
      `INSERT INTO events (learner_id,kind,at) VALUES (?,?,?)`
    ).bind(id, e.kind, e.at));
  }
  // Trimming rides along with a write that was happening anyway, so the log
  // never needs a cron job to stay small.
  stmts.push(env.DB.prepare(`DELETE FROM events WHERE at < ?`)
    .bind(t - EVENT_RETENTION_DAYS * 86400));

  await env.DB.batch(stmts);
  return ok({ at: t, pct: p.pct }, req, env);
}

/* GET /api/roster   header: X-Teacher-Key
   The only endpoint that returns more than one learner, and the only one
   that needs the key. */
async function roster(req, env) {
  const key = req.headers.get('X-Teacher-Key') || '';
  if (!isKey(key)) return err('bad_key', 'مفتاح المعلّم غير صالح', 400, req, env);

  const cls = await env.DB.prepare(
    `SELECT code, label, created_at, max_learners FROM classes WHERE teacher_key = ?`
  ).bind(key).first();
  if (!cls) return err('no_class', 'لا يوجد فصل بهذا المفتاح', 404, req, env);

  const t = now();
  const { results } = await env.DB.prepare(
    `SELECT l.alias, l.joined_at, l.last_sync_at,
            COALESCE(p.pct,0)         AS pct,
            COALESCE(p.done_total,0)  AS done_total,
            COALESCE(p.total_items,?) AS total_items,
            COALESCE(p.stations,0)    AS stations,
            COALESCE(p.grammar,0)     AS grammar,
            COALESCE(p.reading,0)     AS reading,
            COALESCE(p.podcast,0)     AS podcast,
            COALESCE(p.conv,0)        AS conv,
            COALESCE(p.streak_days,0) AS streak_days,
            (SELECT COUNT(*) FROM events e
              WHERE e.learner_id = l.id AND e.at > ?) AS done_7d
       FROM learners l LEFT JOIN progress p ON p.learner_id = l.id
      WHERE l.class_code = ? AND l.removed = 0
      ORDER BY l.last_sync_at DESC`
  ).bind(CURRICULUM_TOTAL, t - 7 * 86400, cls.code).all();

  await env.DB.prepare(`UPDATE classes SET last_seen_at = ? WHERE code = ?`)
    .bind(t, cls.code).run();

  const pcts = results.map((r) => r.pct);
  return ok({
    code: cls.code,
    label: cls.label,
    created_at: cls.created_at,
    max_learners: cls.max_learners,
    curriculum_total: CURRICULUM_TOTAL,
    learners: results,
    summary: {
      count: results.length,
      // A mean hides the shape of a class; the median and the count of
      // learners who have gone quiet are what a teacher actually acts on.
      median_pct: median(pcts),
      active_7d: results.filter((r) => r.last_sync_at > t - 7 * 86400).length,
      stalled_14d: results.filter((r) => r.last_sync_at <= t - 14 * 86400).length,
      not_started: results.filter((r) => r.done_total === 0).length
    }
  }, req, env);
}

function median(arr) {
  if (!arr.length) return 0;
  const s = [...arr].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : Math.floor((s[m - 1] + s[m]) / 2);
}

/* POST /api/learner/remove  { alias }   header: X-Teacher-Key
   Hides a row from the dashboard. The learner's own device keeps everything;
   this is a classroom-management action, not a deletion. */
async function removeLearner(req, env) {
  const key = req.headers.get('X-Teacher-Key') || '';
  if (!isKey(key)) return err('bad_key', 'مفتاح المعلّم غير صالح', 400, req, env);
  const b = await readBody(req);
  const alias = String(b.alias || '').trim();
  if (!alias) return err('bad_alias', 'حدّد الاسم', 400, req, env);

  const cls = await env.DB.prepare(
    `SELECT code FROM classes WHERE teacher_key = ?`
  ).bind(key).first();
  if (!cls) return err('no_class', 'لا يوجد فصل بهذا المفتاح', 404, req, env);

  const r = await env.DB.prepare(
    `UPDATE learners SET removed = 1 WHERE class_code = ? AND alias = ? AND removed = 0`
  ).bind(cls.code, alias).run();
  if (!r.meta.changes) return err('not_found', 'لا يوجد هذا الاسم في الفصل', 404, req, env);
  return ok({ removed: alias }, req, env);
}

/* DELETE /api/learner  { learner_id }
   The learner erasing themselves. Hard delete, cascading to progress and
   events, because a right to erasure that leaves the rows behind is not one.
   Needs no teacher key: it is their data. */
async function deleteLearner(req, env) {
  const b = await readBody(req);
  const id = b.learner_id;
  if (!isLearnerId(id)) return err('bad_learner', 'معرّف الجهاز غير صالح', 400, req, env);
  await env.DB.batch([
    env.DB.prepare(`DELETE FROM events   WHERE learner_id = ?`).bind(id),
    env.DB.prepare(`DELETE FROM progress WHERE learner_id = ?`).bind(id),
    env.DB.prepare(`DELETE FROM learners WHERE id = ?`).bind(id)
  ]);
  return ok({ deleted: true }, req, env);
}

/* POST /api/class/archive   header: X-Teacher-Key
   Closes a class: no new joins, no syncs. Reversible by the same key. */
async function archiveClass(req, env) {
  const key = req.headers.get('X-Teacher-Key') || '';
  if (!isKey(key)) return err('bad_key', 'مفتاح المعلّم غير صالح', 400, req, env);
  const b = await readBody(req);
  const to = b.archived === false ? 0 : 1;
  const r = await env.DB.prepare(
    `UPDATE classes SET archived = ? WHERE teacher_key = ?`
  ).bind(to, key).run();
  if (!r.meta.changes) return err('no_class', 'لا يوجد فصل بهذا المفتاح', 404, req, env);
  return ok({ archived: !!to }, req, env);
}

function aliasMessage(code) {
  switch (code) {
    case 'alias_too_short':        return 'الاسم قصير جدًّا';
    case 'alias_too_long':         return 'الاسم طويل، ' + ALIAS_MAX + ' حرفًا كحدّ أقصى';
    case 'alias_looks_like_email': return 'لا تستخدم بريدًا إلكترونيًّا كاسم';
    case 'alias_looks_like_phone': return 'لا تستخدم رقم جوّال كاسم';
    case 'alias_bad_chars':        return 'الاسم يحتوي رموزًا غير مسموحة';
    default:                       return 'اختر اسمًا مستعارًا';
  }
}

// ── entry point ───────────────────────────────────────────────────────────

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    const path = url.pathname.replace(/\/+$/, '') || '/';

    if (req.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders(req, env) });
    }

    if (!env.DB) {
      return err('no_db', 'قاعدة البيانات غير مربوطة بالخادم', 500, req, env);
    }

    try {
      if (path === '/api/health' && req.method === 'GET') {
        return ok({ service: 'wordspark-api', curriculum_total: CURRICULUM_TOTAL }, req, env);
      }
      if (path === '/api/class' && req.method === 'POST')   return await createClass(req, env);
      if (path === '/api/class' && req.method === 'GET')    return await peekClass(req, env, url);
      if (path === '/api/class/archive' && req.method === 'POST') return await archiveClass(req, env);
      if (path === '/api/join' && req.method === 'POST')    return await joinClass(req, env);
      if (path === '/api/sync' && req.method === 'POST')    return await sync(req, env);
      if (path === '/api/roster' && req.method === 'GET')   return await roster(req, env);
      if (path === '/api/learner/remove' && req.method === 'POST') return await removeLearner(req, env);
      if (path === '/api/learner' && req.method === 'DELETE')      return await deleteLearner(req, env);

      return err('not_found', 'لا يوجد هذا المسار', 404, req, env);
    } catch (e) {
      const m = String(e && e.message || e);
      if (m === 'body_too_large') return err('too_large', 'الطلب كبير جدًّا', 413, req, env);
      if (m === 'bad_json')       return err('bad_json', 'صيغة الطلب غير صحيحة', 400, req, env);
      // The message is logged for the operator and withheld from the client:
      // a D1 error can name columns, and that is free reconnaissance.
      console.error('wordspark-api', path, m);
      return err('server_error', 'خطأ في الخادم', 500, req, env);
    }
  }
};
