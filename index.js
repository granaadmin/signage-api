const express = require('express');
const cors = require('cors');
const path = require('path');
const { Pool } = require('pg');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const multer = require('multer');
const { v4: uuidv4 } = require('uuid');
const fs = require('fs');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3001;
const JWT_SECRET = process.env.JWT_SECRET || 'signage-dev-secret-2025';
const UPLOAD_DIR = process.env.UPLOAD_DIR || './uploads';

// ── DB ────────────────────────────────────────────────────────────────────────
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

pool.connect()
  .then(c => { console.log('✅ Banco conectado'); c.release(); })
  .catch(e => { console.error('❌ Banco erro:', e.message); process.exit(1); });

async function query(text, params) { return pool.query(text, params); }

async function withTenant(tenantId, fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`SET LOCAL app.tenant_id = '${tenantId}'`);
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (e) { await client.query('ROLLBACK'); throw e; }
  finally { client.release(); }
}

// ── AUTH ──────────────────────────────────────────────────────────────────────
function signToken(payload, exp) { return jwt.sign(payload, JWT_SECRET, { expiresIn: exp || '7d' }); }
function verifyToken(token) { return jwt.verify(token, JWT_SECRET); }

function requireAuth(req, res, next) {
  const h = req.headers.authorization;
  if (!h || !h.startsWith('Bearer ')) return res.status(401).json({ error: 'Token não fornecido' });
  try { req.user = verifyToken(h.slice(7)); next(); }
  catch { return res.status(401).json({ error: 'Token inválido' }); }
}
function requireUser(req, res, next) {
  requireAuth(req, res, () => {
    if (req.user.type !== 'user') return res.status(403).json({ error: 'Acesso negado' });
    next();
  });
}
function requirePlayer(req, res, next) {
  requireAuth(req, res, () => {
    if (req.user.type !== 'player') return res.status(403).json({ error: 'Token de player necessário' });
    next();
  });
}
function requireRole(...roles) {
  return (req, res, next) => requireAuth(req, res, () => {
    if (!roles.includes(req.user.role)) return res.status(403).json({ error: 'Sem permissão' });
    next();
  });
}

// ── MIDDLEWARE ────────────────────────────────────────────────────────────────
app.use(cors({ origin: true, credentials: true }));
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });
app.use('/uploads', express.static(path.resolve(UPLOAD_DIR)));

// ── UPLOAD ────────────────────────────────────────────────────────────────────
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const dir = path.join(UPLOAD_DIR, req.user.tenant_id);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    cb(null, dir);
  },
  filename: (req, file, cb) => cb(null, uuidv4() + path.extname(file.originalname))
});
const upload = multer({ storage, limits: { fileSize: 500 * 1024 * 1024 } });

// ── HEALTH ────────────────────────────────────────────────────────────────────
app.get('/health', (req, res) => res.json({ status: 'ok', version: '2.0.0', ts: new Date().toISOString() }));

// ── DEBUG ─────────────────────────────────────────────────────────────────────
app.get('/debug/tables', async (req, res) => {
  const r = await query(`SELECT table_name FROM information_schema.tables WHERE table_schema='public' ORDER BY table_name`);
  res.json(r.rows.map(x => x.table_name));
});
app.get('/debug/tvs', async (req, res) => {
  const r = await query('SELECT id, name, unit_id, is_paired, pairing_code, last_seen_at, token IS NOT NULL as has_token FROM tvs ORDER BY created_at DESC');
  res.json(r.rows);
});
app.get('/debug/playlists', async (req, res) => {
  const r = await query('SELECT p.id, p.name, p.unit_id, p.is_default, COUNT(pi.id) as items FROM playlists p LEFT JOIN playlist_items pi ON pi.playlist_id=p.id GROUP BY p.id ORDER BY p.created_at DESC');
  res.json(r.rows);
});

// ── AUTH ROUTES ───────────────────────────────────────────────────────────────
app.post('/api/auth/register', async (req, res) => {
  const { company_name, email, password, name } = req.body;
  if (!company_name || !email || !password || !name) return res.status(400).json({ error: 'Preencha todos os campos' });
  if (password.length < 8) return res.status(400).json({ error: 'Senha deve ter pelo menos 8 caracteres' });
  const slug = company_name.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  try {
    const ex = await query('SELECT id FROM users WHERE email=$1', [email]);
    if (ex.rows.length) return res.status(409).json({ error: 'Email já cadastrado' });
    const hash = await bcrypt.hash(password, 12);
    const r = await query(`WITH t AS (INSERT INTO tenants(name,slug,plan,max_units,max_tvs_per_unit,storage_gb) VALUES($1,$2,'starter',3,5,10) RETURNING id) INSERT INTO users(tenant_id,email,password_hash,name,role) SELECT id,$3,$4,$5,'owner' FROM t RETURNING id,tenant_id,email,name,role`, [company_name, slug, email, hash, name]);
    const u = r.rows[0];
    res.status(201).json({ token: signToken({ sub: u.id, tenant_id: u.tenant_id, role: u.role, type: 'user' }), user: { id: u.id, email: u.email, name: u.name, role: u.role }, tenant_id: u.tenant_id });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/auth/login', async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ error: 'Email e senha obrigatórios' });
  try {
    const r = await query(`SELECT u.*,t.name as company_name,t.plan,t.slug FROM users u JOIN tenants t ON t.id=u.tenant_id WHERE u.email=$1 AND t.is_active=true`, [email]);
    if (!r.rows.length) return res.status(401).json({ error: 'Email ou senha incorretos' });
    const u = r.rows[0];
    if (!u.is_active) return res.status(401).json({ error: 'Usuário inativo' });
    if (!await bcrypt.compare(password, u.password_hash)) return res.status(401).json({ error: 'Email ou senha incorretos' });
    await query('UPDATE users SET last_login_at=NOW() WHERE id=$1', [u.id]);
    res.json({ token: signToken({ sub: u.id, tenant_id: u.tenant_id, role: u.role, type: 'user' }), user: { id: u.id, email: u.email, name: u.name, role: u.role, company_name: u.company_name, plan: u.plan }, tenant_id: u.tenant_id });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/auth/me', requireUser, async (req, res) => {
  try {
    const r = await query(`SELECT u.id,u.email,u.name,u.role,t.name as company_name,t.plan,t.slug FROM users u JOIN tenants t ON t.id=u.tenant_id WHERE u.id=$1`, [req.user.sub]);
    if (!r.rows.length) return res.status(404).json({ error: 'Não encontrado' });
    res.json(r.rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── UNITS ─────────────────────────────────────────────────────────────────────
app.get('/api/units', requireUser, async (req, res) => {
  try {
    const r = await query(`SELECT u.*,COUNT(DISTINCT t.id) as tv_count,COUNT(DISTINCT t.id) FILTER(WHERE t.last_seen_at>NOW()-INTERVAL '1 minute') as tvs_online FROM units u LEFT JOIN tvs t ON t.unit_id=u.id WHERE u.tenant_id=$1 AND u.is_active=true GROUP BY u.id ORDER BY u.name`, [req.user.tenant_id]);
    res.json(r.rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/units', requireUser, requireRole('owner','admin'), async (req, res) => {
  const { name, city, timezone, description } = req.body;
  if (!name) return res.status(400).json({ error: 'Nome obrigatório' });
  try {
    const r = await query(`INSERT INTO units(tenant_id,name,description,city,timezone) VALUES($1,$2,$3,$4,$5) RETURNING *`, [req.user.tenant_id, name, description||null, city||null, timezone||'America/Sao_Paulo']);
    res.status(201).json(r.rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/units/:id', requireUser, requireRole('owner','admin'), async (req, res) => {
  try {
    await query('UPDATE units SET is_active=false WHERE id=$1 AND tenant_id=$2', [req.params.id, req.user.tenant_id]);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── TVS ───────────────────────────────────────────────────────────────────────
app.get('/api/tvs', requireUser, async (req, res) => {
  try {
    const r = await query(`SELECT t.*,u.name as unit_name,p_tv.name as tv_playlist_name,p_unit.name as unit_playlist_name,COALESCE(p_tv.name,p_unit.name) as active_playlist_name,CASE WHEN t.last_seen_at>NOW()-INTERVAL '1 minute' THEN 'online' WHEN t.last_seen_at>NOW()-INTERVAL '5 minutes' THEN 'idle' ELSE 'offline' END as status FROM tvs t JOIN units u ON u.id=t.unit_id LEFT JOIN playlists p_tv ON p_tv.id=t.playlist_id LEFT JOIN playlists p_unit ON p_unit.unit_id=t.unit_id AND p_unit.is_default=true WHERE t.tenant_id=$1 ORDER BY u.name,t.name`, [req.user.tenant_id]);
    res.json(r.rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/tvs', requireUser, requireRole('owner','admin'), async (req, res) => {
  const { name, unit_id, pairing_code } = req.body;
  if (!name || !unit_id || !pairing_code || pairing_code.length !== 6) return res.status(400).json({ error: 'Dados inválidos' });
  try {
    const r = await query(`INSERT INTO tvs(id,tenant_id,unit_id,name,pairing_code,is_paired) VALUES($1,$2,$3,$4,$5,false) RETURNING *`, [uuidv4(), req.user.tenant_id, unit_id, name, pairing_code.toUpperCase()]);
    res.status(201).json(r.rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/tvs/pair', async (req, res) => {
  const { pairing_code } = req.body;
  if (!pairing_code) return res.status(400).json({ error: 'Código obrigatório' });
  try {
    const r = await query('SELECT * FROM tvs WHERE pairing_code=$1 AND is_paired=false', [pairing_code.toUpperCase().trim()]);
    if (!r.rows.length) return res.status(404).json({ error: 'Código não encontrado ou já utilizado' });
    const tv = r.rows[0];
    const token = signToken({ sub: tv.id, tenant_id: tv.tenant_id, role: 'player', unit_id: tv.unit_id, type: 'player' }, '365d');
    await query(`UPDATE tvs SET is_paired=true,token=$1,pairing_code=NULL,ip_address=$2,user_agent=$3,updated_at=NOW() WHERE id=$4`, [token, req.ip, req.headers['user-agent']||'', tv.id]);
    res.json({ token, tv_id: tv.id, unit_id: tv.unit_id });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/tvs/heartbeat', requirePlayer, async (req, res) => {
  try {
    await query(`UPDATE tvs SET last_seen_at=NOW(),ip_address=$2,resolution=$3,updated_at=NOW() WHERE id=$1`, [req.user.sub, req.ip, req.body.resolution||null]);
    const upd = await query(`SELECT id FROM schedules WHERE unit_id=$1 AND is_active=true AND updated_at>$2 LIMIT 1`, [req.user.unit_id, req.body.last_sync||'2000-01-01']);
    res.json({ ok: true, has_update: upd.rows.length > 0, server_time: new Date().toISOString() });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/tvs/:id/playlist', requireUser, async (req, res) => {
  try {
    await query('UPDATE tvs SET playlist_id=$1,updated_at=NOW() WHERE id=$2 AND tenant_id=$3', [req.body.playlist_id||null, req.params.id, req.user.tenant_id]);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/tvs/:id', requireUser, requireRole('owner','admin'), async (req, res) => {
  try {
    await query('DELETE FROM tvs WHERE id=$1 AND tenant_id=$2', [req.params.id, req.user.tenant_id]);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── CONTENTS ──────────────────────────────────────────────────────────────────
app.get('/api/contents', requireUser, async (req, res) => {
  try {
    const r = await query(`SELECT c.*,u.name as created_by_name FROM contents c LEFT JOIN users u ON u.id=c.created_by WHERE c.tenant_id=$1 AND c.is_active=true ORDER BY c.created_at DESC`, [req.user.tenant_id]);
    res.json(r.rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/contents/upload', requireUser, upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Nenhum arquivo' });
  if (!req.body.name) return res.status(400).json({ error: 'Nome obrigatório' });
  const type = req.file.mimetype.startsWith('video/') ? 'video' : 'image';
  const filePath = req.user.tenant_id + '/' + path.basename(req.file.path);
  try {
    const r = await query(`INSERT INTO contents(tenant_id,name,type,file_path,file_size,duration,created_by) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING *`, [req.user.tenant_id, req.body.name, type, filePath, req.file.size, req.body.duration||null, req.user.sub]);
    res.status(201).json(r.rows[0]);
  } catch (e) { fs.unlinkSync(req.file.path); res.status(500).json({ error: e.message }); }
});

app.delete('/api/contents/:id', requireUser, async (req, res) => {
  try {
    await query('UPDATE contents SET is_active=false WHERE id=$1 AND tenant_id=$2', [req.params.id, req.user.tenant_id]);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── PLAYLISTS ─────────────────────────────────────────────────────────────────
app.get('/api/playlists', requireUser, async (req, res) => {
  try {
    const r = await query(`SELECT p.*,u.name as unit_name,COUNT(pi.id) as item_count FROM playlists p LEFT JOIN units u ON u.id=p.unit_id LEFT JOIN playlist_items pi ON pi.playlist_id=p.id WHERE p.tenant_id=$1 GROUP BY p.id,u.name ORDER BY p.created_at DESC`, [req.user.tenant_id]);
    res.json(r.rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/playlists/schedules/:unit_id/active', requireAuth, async (req, res) => {
  try {
    const dow = new Date().getDay();
    const tvId = req.query.tv_id || null;
    // Check TV-specific playlist
    if (tvId) {
      const tvPl = await query(`SELECT p.id FROM tvs t JOIN playlists p ON p.id=t.playlist_id WHERE t.id=$1 AND t.tenant_id=$2 AND t.playlist_id IS NOT NULL`, [tvId, req.user.tenant_id]);
      if (tvPl.rows.length) {
        const items = await query(`SELECT pi.*,c.type,c.file_path,c.duration,c.template_data,c.name FROM playlist_items pi JOIN contents c ON c.id=pi.content_id WHERE pi.playlist_id=$1 AND c.is_active=true ORDER BY pi.position`, [tvPl.rows[0].id]);
        return res.json({ playlist_id: tvPl.rows[0].id, source: 'tv', items: items.rows });
      }
    }
    // Check schedule
    const sched = await query(`SELECT s.playlist_id FROM schedules s WHERE s.unit_id=$1 AND s.is_active=true AND s.starts_at<=NOW() AND (s.ends_at IS NULL OR s.ends_at>=NOW()) AND $2=ANY(s.days_of_week) ORDER BY s.priority DESC LIMIT 1`, [req.params.unit_id, dow]);
    let plId;
    if (sched.rows.length) { plId = sched.rows[0].playlist_id; }
    else {
      const def = await query('SELECT id FROM playlists WHERE unit_id=$1 AND is_default=true AND tenant_id=$2 LIMIT 1', [req.params.unit_id, req.user.tenant_id]);
      if (!def.rows.length) return res.json(null);
      plId = def.rows[0].id;
    }
    const items = await query(`SELECT pi.*,c.type,c.file_path,c.duration,c.template_data,c.name FROM playlist_items pi JOIN contents c ON c.id=pi.content_id WHERE pi.playlist_id=$1 AND c.is_active=true ORDER BY pi.position`, [plId]);
    res.json({ playlist_id: plId, source: 'unit', items: items.rows });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/playlists/:id', requireUser, async (req, res) => {
  try {
    const pl = await query('SELECT * FROM playlists WHERE id=$1 AND tenant_id=$2', [req.params.id, req.user.tenant_id]);
    if (!pl.rows.length) return res.status(404).json({ error: 'Não encontrada' });
    const items = await query(`SELECT pi.*,c.name,c.type,c.file_path,c.duration,c.template_data FROM playlist_items pi JOIN contents c ON c.id=pi.content_id WHERE pi.playlist_id=$1 AND c.is_active=true ORDER BY pi.position`, [req.params.id]);
    res.json({ ...pl.rows[0], items: items.rows });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/playlists', requireUser, async (req, res) => {
  const { name, unit_id, description, is_default, items = [] } = req.body;
  if (!name) return res.status(400).json({ error: 'Nome obrigatório' });
  try {
    let setDefault = is_default || false;
    if (unit_id && !setDefault) {
      const cnt = await query('SELECT COUNT(*) FROM playlists WHERE unit_id=$1 AND tenant_id=$2', [unit_id, req.user.tenant_id]);
      if (parseInt(cnt.rows[0].count) === 0) setDefault = true;
    }
    if (setDefault && unit_id) {
      await query('UPDATE playlists SET is_default=false WHERE unit_id=$1 AND tenant_id=$2', [unit_id, req.user.tenant_id]);
    }
    const pl = await query(`INSERT INTO playlists(tenant_id,unit_id,name,description,is_default,created_by) VALUES($1,$2,$3,$4,$5,$6) RETURNING *`, [req.user.tenant_id, unit_id||null, name, description||null, setDefault, req.user.sub]);
    for (let i = 0; i < items.length; i++) {
      await query(`INSERT INTO playlist_items(playlist_id,content_id,position,duration_override) VALUES($1,$2,$3,$4)`, [pl.rows[0].id, items[i].content_id, items[i].position??i, items[i].duration_override||null]);
    }
    res.status(201).json(pl.rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/playlists/duplicate/:id', requireUser, async (req, res) => {
  try {
    const orig = await query('SELECT * FROM playlists WHERE id=$1 AND tenant_id=$2', [req.params.id, req.user.tenant_id]);
    if (!orig.rows.length) return res.status(404).json({ error: 'Não encontrada' });
    const p = orig.rows[0];
    const copy = await query(`INSERT INTO playlists(tenant_id,unit_id,name,description,is_default,created_by) VALUES($1,$2,$3,$4,false,$5) RETURNING *`, [req.user.tenant_id, p.unit_id, p.name+' (cópia)', p.description, req.user.sub]);
    const its = await query('SELECT * FROM playlist_items WHERE playlist_id=$1 ORDER BY position', [p.id]);
    for (const it of its.rows) {
      await query(`INSERT INTO playlist_items(playlist_id,content_id,position,duration_override) VALUES($1,$2,$3,$4)`, [copy.rows[0].id, it.content_id, it.position, it.duration_override]);
    }
    res.status(201).json(copy.rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/playlists/:id/items', requireUser, async (req, res) => {
  const { items = [] } = req.body;
  try {
    await query('DELETE FROM playlist_items WHERE playlist_id=$1', [req.params.id]);
    for (let i = 0; i < items.length; i++) {
      await query(`INSERT INTO playlist_items(playlist_id,content_id,position,duration_override) VALUES($1,$2,$3,$4)`, [req.params.id, items[i].content_id, items[i].position??i, items[i].duration_override||null]);
    }
    await query('UPDATE playlists SET updated_at=NOW() WHERE id=$1', [req.params.id]);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/playlists/:id/set-default', requireUser, async (req, res) => {
  try {
    const pl = await query('SELECT unit_id FROM playlists WHERE id=$1 AND tenant_id=$2', [req.params.id, req.user.tenant_id]);
    if (!pl.rows.length) return res.status(404).json({ error: 'Não encontrada' });
    await query('UPDATE playlists SET is_default=false WHERE unit_id=$1 AND tenant_id=$2', [pl.rows[0].unit_id, req.user.tenant_id]);
    await query('UPDATE playlists SET is_default=true,updated_at=NOW() WHERE id=$1', [req.params.id]);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/playlists/:id', requireUser, async (req, res) => {
  try {
    const pl = await query('SELECT * FROM playlists WHERE id=$1 AND tenant_id=$2', [req.params.id, req.user.tenant_id]);
    if (!pl.rows.length) return res.json({ success: true });
    const { is_default, unit_id } = pl.rows[0];
    await query('DELETE FROM playlists WHERE id=$1 AND tenant_id=$2', [req.params.id, req.user.tenant_id]);
    if (is_default && unit_id) {
      await query(`UPDATE playlists SET is_default=true WHERE id=(SELECT id FROM playlists WHERE unit_id=$1 AND tenant_id=$2 ORDER BY created_at ASC LIMIT 1)`, [unit_id, req.user.tenant_id]);
    }
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── SCHEDULES ─────────────────────────────────────────────────────────────────
app.post('/api/playlists/schedules', requireUser, async (req, res) => {
  const { unit_id, playlist_id, name, starts_at, ends_at, days_of_week, priority } = req.body;
  if (!unit_id || !playlist_id || !starts_at) return res.status(400).json({ error: 'Dados obrigatórios' });
  try {
    const r = await query(`INSERT INTO schedules(tenant_id,unit_id,playlist_id,name,starts_at,ends_at,days_of_week,priority) VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`, [req.user.tenant_id, unit_id, playlist_id, name||null, starts_at, ends_at||null, days_of_week||[0,1,2,3,4,5,6], priority||0]);
    res.status(201).json(r.rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── ANALYTICS ─────────────────────────────────────────────────────────────────
app.post('/api/analytics/event', requirePlayer, async (req, res) => {
  const { event_type, content_id, duration_ms, metadata } = req.body;
  try {
    await query(`INSERT INTO analytics_events(tenant_id,tv_id,unit_id,content_id,event_type,duration_ms,metadata) VALUES($1,$2,$3,$4,$5,$6,$7)`, [req.user.tenant_id, req.user.sub, req.user.unit_id, content_id||null, event_type, duration_ms||null, JSON.stringify(metadata||{})]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/analytics/dashboard', requireUser, async (req, res) => {
  const days = parseInt(req.query.days) || 7;
  try {
    const tvs = await query(`SELECT COUNT(*) FILTER(WHERE last_seen_at>NOW()-INTERVAL '1 minute') as online,COUNT(*) FILTER(WHERE last_seen_at>NOW()-INTERVAL '5 minutes' AND last_seen_at<=NOW()-INTERVAL '1 minute') as idle,COUNT(*) FILTER(WHERE last_seen_at IS NULL OR last_seen_at<=NOW()-INTERVAL '5 minutes') as offline,COUNT(*) as total FROM tvs WHERE tenant_id=$1`, [req.user.tenant_id]);
    const top = await query(`SELECT c.name,c.type,COUNT(*) as plays FROM analytics_events ae JOIN contents c ON c.id=ae.content_id WHERE ae.tenant_id=$1 AND ae.event_type='content_played' AND ae.occurred_at>NOW()-($2||' days')::INTERVAL GROUP BY c.id,c.name,c.type ORDER BY plays DESC LIMIT 10`, [req.user.tenant_id, days]);
    const units = await query(`SELECT u.name as unit_name,u.id as unit_id,COUNT(t.id) as total_tvs,COUNT(t.id) FILTER(WHERE t.last_seen_at>NOW()-INTERVAL '1 minute') as online_tvs FROM units u LEFT JOIN tvs t ON t.unit_id=u.id WHERE u.tenant_id=$1 AND u.is_active=true GROUP BY u.id,u.name ORDER BY u.name`, [req.user.tenant_id]);
    res.json({ tvs: tvs.rows[0], top_content: top.rows, unit_status: units.rows });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── START ─────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`\n🚀 PLAY.O API rodando em http://localhost:${PORT}`);
  console.log(`📊 Health: http://localhost:${PORT}/health`);
  console.log(`🔍 Debug TVs: http://localhost:${PORT}/debug/tvs\n`);
});
