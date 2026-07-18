// PLAY.O API v2
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
const JWT_SECRET = process.env.JWT_SECRET || 'playo-secret-2025';
const UPLOAD_DIR = process.env.UPLOAD_DIR || './uploads';

// ── DB ────────────────────────────────────────────────────────────────────────
console.log('DATABASE_URL set:', !!process.env.DATABASE_URL);
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
pool.connect()
  .then(c => { console.log('✅ PostgreSQL conectado'); c.release(); })
  .catch(e => { console.error('❌ DB erro:', e.message, e.code); });

async function query(text, params) { return pool.query(text, params); }

// ── UTILS ─────────────────────────────────────────────────────────────────────
function genCode(len = 6) {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  return Array.from({ length: len }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
}

async function uniqueCode() {
  let code, exists = true;
  while (exists) {
    code = genCode();
    const r = await query('SELECT id FROM spaces WHERE pairing_code=$1', [code]);
    exists = r.rows.length > 0;
  }
  return code;
}

async function logActivity(tenantId, type, message, metadata = {}) {
  try {
    await query('INSERT INTO activity_logs(tenant_id,type,message,metadata) VALUES($1,$2,$3,$4)',
      [tenantId, type, message, JSON.stringify(metadata)]);
  } catch {}
}

async function createAlert(tenantId, type, severity, title, message) {
  try {
    // Avoid duplicate unresolved alerts of same type+title
    const ex = await query(
      'SELECT id FROM alerts WHERE tenant_id=$1 AND type=$2 AND title=$3 AND resolved=false',
      [tenantId, type, title]
    );
    if (!ex.rows.length) {
      await query('INSERT INTO alerts(tenant_id,type,severity,title,message) VALUES($1,$2,$3,$4,$5)',
        [tenantId, type, severity, title, message]);
    }
  } catch {}
}

// ── AUTH ──────────────────────────────────────────────────────────────────────
function signToken(payload, exp = '7d') { return jwt.sign(payload, JWT_SECRET, { expiresIn: exp }); }
function verifyToken(token) { return jwt.verify(token, JWT_SECRET); }

function requireUser(req, res, next) {
  const h = req.headers.authorization;
  if (!h || !h.startsWith('Bearer ')) return res.status(401).json({ error: 'Token não fornecido' });
  try {
    const p = verifyToken(h.slice(7));
    if (p.type !== 'user') return res.status(403).json({ error: 'Acesso negado' });
    req.user = p; next();
  } catch { res.status(401).json({ error: 'Token inválido' }); }
}

function requirePlayer(req, res, next) {
  const h = req.headers.authorization;
  if (!h || !h.startsWith('Bearer ')) return res.status(401).json({ error: 'Token não fornecido' });
  try {
    const p = verifyToken(h.slice(7));
    if (p.type !== 'player') return res.status(403).json({ error: 'Token de player necessário' });
    req.player = p; next();
  } catch { res.status(401).json({ error: 'Token inválido' }); }
}

// ── MIDDLEWARE ─────────────────────────────────────────────────────────────────
app.use(cors({ origin: true, credentials: true }));
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });
app.use('/uploads', express.static(path.resolve(UPLOAD_DIR)));

// ── UPLOAD ────────────────────────────────────────────────────────────────────
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const dir = path.join(UPLOAD_DIR, req.user?.tenant_id || 'tmp');
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    cb(null, dir);
  },
  filename: (req, file, cb) => cb(null, uuidv4() + path.extname(file.originalname).toLowerCase())
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
  const r = await query('SELECT id,name,unit_id,space_id,is_paired,pairing_code,last_seen_at FROM tvs ORDER BY created_at DESC');
  res.json(r.rows);
});
app.get('/debug/spaces', async (req, res) => {
  const r = await query('SELECT * FROM spaces ORDER BY created_at DESC');
  res.json(r.rows);
});

// ── AUTH ROUTES ───────────────────────────────────────────────────────────────
app.post('/api/auth/register', async (req, res) => {
  const { company_name, email, password, name } = req.body;
  if (!company_name || !email || !password || !name)
    return res.status(400).json({ error: 'Preencha todos os campos' });
  if (password.length < 8)
    return res.status(400).json({ error: 'Senha deve ter pelo menos 8 caracteres' });
  const slug = company_name.toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') + '-' + Date.now();
  try {
    const ex = await query('SELECT id FROM users WHERE email=$1', [email]);
    if (ex.rows.length) return res.status(409).json({ error: 'Email já cadastrado' });
    const hash = await bcrypt.hash(password, 12);
    const r = await query(
      `WITH t AS (INSERT INTO tenants(name,slug,plan,max_units,max_tvs_per_unit,storage_gb)
       VALUES($1,$2,'starter',5,10,10) RETURNING id)
       INSERT INTO users(tenant_id,email,password_hash,name,role)
       SELECT id,$3,$4,$5,'owner' FROM t RETURNING id,tenant_id,email,name,role`,
      [company_name, slug, email, hash, name]
    );
    const u = r.rows[0];
    // Create default brand settings
    await query('INSERT INTO brand_settings(tenant_id) VALUES($1) ON CONFLICT DO NOTHING', [u.tenant_id]);
    const token = signToken({ sub: u.id, tenant_id: u.tenant_id, role: u.role, type: 'user' });
    res.status(201).json({ token, user: { id: u.id, email: u.email, name: u.name, role: u.role } });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/auth/login', async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ error: 'Email e senha obrigatórios' });
  try {
    const r = await query(
      `SELECT u.*,t.name as company_name,t.plan FROM users u
       JOIN tenants t ON t.id=u.tenant_id
       WHERE u.email=$1 AND t.is_active=true AND u.is_active=true`, [email]
    );
    if (!r.rows.length) return res.status(401).json({ error: 'Email ou senha incorretos' });
    const u = r.rows[0];
    if (!await bcrypt.compare(password, u.password_hash))
      return res.status(401).json({ error: 'Email ou senha incorretos' });
    await query('UPDATE users SET last_login_at=NOW() WHERE id=$1', [u.id]);
    const token = signToken({ sub: u.id, tenant_id: u.tenant_id, role: u.role, type: 'user' });
    res.json({ token, user: { id: u.id, email: u.email, name: u.name, role: u.role, company_name: u.company_name, plan: u.plan } });
  } catch (e) { console.error('LOGIN ERR:', e); res.status(500).json({ error: e.message || e.toString() || 'erro desconhecido' }); }
});

app.get('/api/auth/me', requireUser, async (req, res) => {
  try {
    const r = await query(
      `SELECT u.id,u.email,u.name,u.role,t.name as company_name,t.plan
       FROM users u JOIN tenants t ON t.id=u.tenant_id WHERE u.id=$1`, [req.user.sub]
    );
    if (!r.rows.length) return res.status(404).json({ error: 'Não encontrado' });
    res.json(r.rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── UNITS ─────────────────────────────────────────────────────────────────────
app.get('/api/units', requireUser, async (req, res) => {
  try {
    const r = await query(
      `SELECT u.*,
        COUNT(DISTINCT s.id) as space_count,
        COUNT(DISTINCT tv.id) as tv_count,
        COUNT(DISTINCT tv.id) FILTER(WHERE tv.last_seen_at > NOW()-INTERVAL '2 minutes') as tvs_online
       FROM units u
       LEFT JOIN spaces s ON s.unit_id=u.id
       LEFT JOIN tvs tv ON tv.unit_id=u.id AND tv.is_paired=true
       WHERE u.tenant_id=$1 AND u.is_active=true
       GROUP BY u.id ORDER BY u.name`, [req.user.tenant_id]
    );
    res.json(r.rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/units', requireUser, async (req, res) => {
  const { name, city, notes } = req.body;
  if (!name) return res.status(400).json({ error: 'Nome obrigatório' });
  try {
    const r = await query(
      'INSERT INTO units(tenant_id,name,city,description) VALUES($1,$2,$3,$4) RETURNING *',
      [req.user.tenant_id, name, city || null, notes || null]
    );
    await logActivity(req.user.tenant_id, 'unit_created', `Unidade "${name}" criada`);
    res.status(201).json(r.rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/units/:id', requireUser, async (req, res) => {
  try {
    await query('UPDATE units SET is_active=false WHERE id=$1 AND tenant_id=$2', [req.params.id, req.user.tenant_id]);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── SPACES ────────────────────────────────────────────────────────────────────
app.get('/api/units/:unitId/spaces', requireUser, async (req, res) => {
  try {
    const r = await query(
      `SELECT s.*,
        COUNT(DISTINCT tv.id) as tv_count,
        COUNT(DISTINCT tv.id) FILTER(WHERE tv.last_seen_at > NOW()-INTERVAL '2 minutes') as tvs_online,
        COUNT(DISTINCT sc.id) as content_count
       FROM spaces s
       LEFT JOIN tvs tv ON tv.space_id=s.id AND tv.is_paired=true
       LEFT JOIN space_contents sc ON sc.space_id=s.id AND sc.active=true
       WHERE s.unit_id=$1 AND s.tenant_id=$2
       GROUP BY s.id ORDER BY s.name`,
      [req.params.unitId, req.user.tenant_id]
    );
    res.json(r.rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/spaces', requireUser, async (req, res) => {
  try {
    const r = await query(
      `SELECT s.*,u.name as unit_name,
        COUNT(DISTINCT tv.id) as tv_count,
        COUNT(DISTINCT tv.id) FILTER(WHERE tv.last_seen_at > NOW()-INTERVAL '2 minutes') as tvs_online,
        COUNT(DISTINCT sc.id) as content_count
       FROM spaces s
       JOIN units u ON u.id=s.unit_id
       LEFT JOIN tvs tv ON tv.space_id=s.id AND tv.is_paired=true
       LEFT JOIN space_contents sc ON sc.space_id=s.id AND sc.active=true
       WHERE s.tenant_id=$1
       GROUP BY s.id,u.name ORDER BY u.name,s.name`,
      [req.user.tenant_id]
    );
    res.json(r.rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/units/:unitId/spaces', requireUser, async (req, res) => {
  const { name, description } = req.body;
  if (!name) return res.status(400).json({ error: 'Nome obrigatório' });
  try {
    const code = await uniqueCode();
    const r = await query(
      'INSERT INTO spaces(tenant_id,unit_id,name,description,pairing_code) VALUES($1,$2,$3,$4,$5) RETURNING *',
      [req.user.tenant_id, req.params.unitId, name, description || null, code]
    );
    await logActivity(req.user.tenant_id, 'space_created', `Espaço "${name}" criado`, { code });
    res.status(201).json(r.rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/spaces/:id', requireUser, async (req, res) => {
  try {
    const space = await query('SELECT * FROM spaces WHERE id=$1 AND tenant_id=$2', [req.params.id, req.user.tenant_id]);
    if (!space.rows.length) return res.status(404).json({ error: 'Não encontrado' });
    const tvs = await query(
      `SELECT *,CASE WHEN last_seen_at > NOW()-INTERVAL '2 minutes' THEN 'online' ELSE 'offline' END as status
       FROM tvs WHERE space_id=$1 ORDER BY name`, [req.params.id]
    );
    const contents = await query(
      `SELECT sc.id as sc_id,sc.sort_order,sc.active,c.*
       FROM space_contents sc
       JOIN contents c ON c.id=sc.content_id
       WHERE sc.space_id=$1 ORDER BY sc.sort_order`, [req.params.id]
    );
    res.json({ ...space.rows[0], tvs: tvs.rows, contents: contents.rows });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/spaces/:id', requireUser, async (req, res) => {
  try {
    await query('DELETE FROM spaces WHERE id=$1 AND tenant_id=$2', [req.params.id, req.user.tenant_id]);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── SPACE CONTENTS ────────────────────────────────────────────────────────────
app.get('/api/spaces/:spaceId/contents', requireUser, async (req, res) => {
  try {
    const r = await query(
      `SELECT sc.id as sc_id,sc.sort_order,sc.active,c.*
       FROM space_contents sc JOIN contents c ON c.id=sc.content_id
       WHERE sc.space_id=$1 AND sc.tenant_id=$2 ORDER BY sc.sort_order`,
      [req.params.spaceId, req.user.tenant_id]
    );
    res.json(r.rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/spaces/:spaceId/contents', requireUser, async (req, res) => {
  const { content_id } = req.body;
  if (!content_id) return res.status(400).json({ error: 'content_id obrigatório' });
  try {
    const maxOrd = await query('SELECT COALESCE(MAX(sort_order),0) as max FROM space_contents WHERE space_id=$1', [req.params.spaceId]);
    const r = await query(
      'INSERT INTO space_contents(tenant_id,space_id,content_id,sort_order) VALUES($1,$2,$3,$4) ON CONFLICT(space_id,content_id) DO UPDATE SET active=true RETURNING *',
      [req.user.tenant_id, req.params.spaceId, content_id, maxOrd.rows[0].max + 1]
    );
    res.status(201).json(r.rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/spaces/:spaceId/contents/reorder', requireUser, async (req, res) => {
  const { order } = req.body; // array of content_ids in new order
  try {
    for (let i = 0; i < order.length; i++) {
      await query('UPDATE space_contents SET sort_order=$1 WHERE space_id=$2 AND content_id=$3 AND tenant_id=$4',
        [i, req.params.spaceId, order[i], req.user.tenant_id]);
    }
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/spaces/:spaceId/contents/:contentId', requireUser, async (req, res) => {
  try {
    await query('DELETE FROM space_contents WHERE space_id=$1 AND content_id=$2 AND tenant_id=$3',
      [req.params.spaceId, req.params.contentId, req.user.tenant_id]);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── CONTENTS ──────────────────────────────────────────────────────────────────
app.get('/api/contents', requireUser, async (req, res) => {
  try {
    const r = await query(
      `SELECT c.*,
        COALESCE(c.content_type, c.type) as content_type,
        ARRAY_AGG(DISTINCT s.name) FILTER(WHERE s.name IS NOT NULL) as space_names
       FROM contents c
       LEFT JOIN space_contents sc ON sc.content_id=c.id
       LEFT JOIN spaces s ON s.id=sc.space_id
       WHERE c.tenant_id=$1 AND c.is_active=true
       GROUP BY c.id ORDER BY c.created_at DESC`, [req.user.tenant_id]
    );
    res.json(r.rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/contents/upload', requireUser, upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Nenhum arquivo enviado' });
  if (!req.body.name) return res.status(400).json({ error: 'Nome obrigatório' });
  const isVideo = req.file.mimetype.startsWith('video/');
  const ctype = isVideo ? 'video' : 'image';
  const filePath = req.user.tenant_id + '/' + path.basename(req.file.path);
  const fileUrl = '/uploads/' + filePath;
  try {
    const r = await query(
      `INSERT INTO contents(tenant_id,name,type,content_type,file_path,file_url,file_size,duration,created_by)
       VALUES($1,$2,$3,$3,$4,$5,$6,$7,$8) RETURNING *`,
      [req.user.tenant_id, req.body.name, ctype, filePath, fileUrl, req.file.size, req.body.duration || null, req.user.sub]
    );
    const content = r.rows[0];
    // Distribute to spaces if provided
    const spaceIds = req.body.space_ids ? JSON.parse(req.body.space_ids) : [];
    for (const sid of spaceIds) {
      const maxOrd = await query('SELECT COALESCE(MAX(sort_order),0) as max FROM space_contents WHERE space_id=$1', [sid]);
      await query(
        'INSERT INTO space_contents(tenant_id,space_id,content_id,sort_order) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING',
        [req.user.tenant_id, sid, content.id, maxOrd.rows[0].max + 1]
      );
    }
    await logActivity(req.user.tenant_id, 'content_uploaded', `Conteúdo "${req.body.name}" enviado`, { type: ctype });
    res.status(201).json(content);
  } catch (e) {
    try { fs.unlinkSync(req.file.path); } catch {}
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/contents/announcement', requireUser, async (req, res) => {
  const { name, title, body, subtitle, expires_at, layout, space_ids, primary_color, bg_color } = req.body;
  if (!name || !title) return res.status(400).json({ error: 'Nome e título obrigatórios' });
  try {
    const templateData = { title, body, subtitle, layout: layout || 'simple', primary_color, bg_color, expires_at };
    const r = await query(
      `INSERT INTO contents(tenant_id,name,type,content_type,duration,template_data,created_by)
       VALUES($1,$2,'announcement','announcement',$3,$4,$5) RETURNING *`,
      [req.user.tenant_id, name, req.body.duration || 15, JSON.stringify(templateData), req.user.sub]
    );
    const content = r.rows[0];
    const sids = space_ids || [];
    for (const sid of sids) {
      const maxOrd = await query('SELECT COALESCE(MAX(sort_order),0) as max FROM space_contents WHERE space_id=$1', [sid]);
      await query(
        'INSERT INTO space_contents(tenant_id,space_id,content_id,sort_order) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING',
        [req.user.tenant_id, sid, content.id, maxOrd.rows[0].max + 1]
      );
    }
    await logActivity(req.user.tenant_id, 'announcement_created', `Comunicado "${name}" criado`);
    res.status(201).json(content);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/contents/:id/distribute', requireUser, async (req, res) => {
  const { space_ids } = req.body;
  if (!space_ids?.length) return res.status(400).json({ error: 'space_ids obrigatório' });
  try {
    for (const sid of space_ids) {
      const maxOrd = await query('SELECT COALESCE(MAX(sort_order),0) as max FROM space_contents WHERE space_id=$1', [sid]);
      await query(
        'INSERT INTO space_contents(tenant_id,space_id,content_id,sort_order) VALUES($1,$2,$3,$4) ON CONFLICT(space_id,content_id) DO UPDATE SET active=true',
        [req.user.tenant_id, sid, req.params.id, maxOrd.rows[0].max + 1]
      );
    }
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/contents/:id', requireUser, async (req, res) => {
  try {
    await query('UPDATE contents SET is_active=false WHERE id=$1 AND tenant_id=$2', [req.params.id, req.user.tenant_id]);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── PLAYER ROUTES ─────────────────────────────────────────────────────────────
app.post('/api/player/pair', async (req, res) => {
  const { pairing_code, device_name } = req.body;
  if (!pairing_code) return res.status(400).json({ error: 'Código obrigatório' });
  try {
    const space = await query('SELECT * FROM spaces WHERE pairing_code=$1', [pairing_code.toUpperCase().trim()]);
    if (!space.rows.length) return res.status(404).json({ error: 'Código não encontrado. Verifique e tente novamente.' });
    const s = space.rows[0];
    // Create or update device
    const devId = uuidv4();
    const token = signToken({
      sub: devId, tenant_id: s.tenant_id, space_id: s.id,
      unit_id: s.unit_id, type: 'player', role: 'player'
    }, '365d');
    const existing = await query('SELECT id FROM tvs WHERE space_id=$1 AND device_identifier=$2', [s.id, req.ip || devId]);
    let tvId;
    if (existing.rows.length) {
      tvId = existing.rows[0].id;
      await query('UPDATE tvs SET token=$1,is_paired=true,last_seen_at=NOW(),name=COALESCE($2,name) WHERE id=$3',
        [token, device_name || null, tvId]);
    } else {
      const tv = await query(
        `INSERT INTO tvs(id,tenant_id,unit_id,space_id,name,is_paired,token,last_seen_at,device_identifier)
         VALUES($1,$2,$3,$4,$5,true,$6,NOW(),$7) RETURNING id`,
        [devId, s.tenant_id, s.unit_id, s.id, device_name || 'TV ' + pairing_code, token, req.ip || devId]
      );
      tvId = tv.rows[0].id;
    }
    await logActivity(s.tenant_id, 'tv_connected', `TV conectada ao espaço "${s.name}"`, { space_id: s.id });
    res.json({ token, tv_id: tvId, space_id: s.id, space_name: s.name, unit_id: s.unit_id });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/player/heartbeat', requirePlayer, async (req, res) => {
  try {
    const was = await query('SELECT last_seen_at FROM tvs WHERE id=$1', [req.player.sub]);
    const wasOffline = was.rows.length && was.rows[0].last_seen_at &&
      new Date() - new Date(was.rows[0].last_seen_at) > 3 * 60 * 1000;
    await query('UPDATE tvs SET last_seen_at=NOW(),updated_at=NOW() WHERE id=$1', [req.player.sub]);
    if (wasOffline) {
      // TV came back online - resolve offline alert
      const tv = await query('SELECT name FROM tvs WHERE id=$1', [req.player.sub]);
      if (tv.rows.length) {
        await query('UPDATE alerts SET resolved=true,resolved_at=NOW() WHERE tenant_id=$1 AND type=$2 AND title LIKE $3 AND resolved=false',
          [req.player.tenant_id, 'tv_offline', `%${tv.rows[0].name}%`]);
        await logActivity(req.player.tenant_id, 'tv_online', `TV voltou a ficar online`, { tv_id: req.player.sub });
      }
    }
    res.json({ ok: true, server_time: new Date().toISOString() });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/player/:tvId/contents', requirePlayer, async (req, res) => {
  try {
    const spaceId = req.player.space_id;
    const contents = await query(
      `SELECT c.id,c.name,COALESCE(c.content_type,c.type) as type,
        c.file_url,c.file_path,c.duration,c.template_data,sc.sort_order
       FROM space_contents sc
       JOIN contents c ON c.id=sc.content_id
       WHERE sc.space_id=$1 AND sc.active=true AND c.is_active=true
       ORDER BY sc.sort_order`, [spaceId]
    );
    // Get space info
    const space = await query(
      'SELECT s.name as space_name,u.name as unit_name FROM spaces s JOIN units u ON u.id=s.unit_id WHERE s.id=$1',
      [spaceId]
    );
    res.json({
      contents: contents.rows,
      space: space.rows[0] || {},
      server_time: new Date().toISOString()
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── BRAND SETTINGS ────────────────────────────────────────────────────────────
app.get('/api/brand-settings', requireUser, async (req, res) => {
  try {
    const r = await query('SELECT * FROM brand_settings WHERE tenant_id=$1', [req.user.tenant_id]);
    res.json(r.rows[0] || {});
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/brand-settings', requireUser, async (req, res) => {
  const { primary_color, secondary_color, background_color, font_family } = req.body;
  try {
    const r = await query(
      `INSERT INTO brand_settings(tenant_id,primary_color,secondary_color,background_color,font_family)
       VALUES($1,$2,$3,$4,$5)
       ON CONFLICT(tenant_id) DO UPDATE SET
         primary_color=EXCLUDED.primary_color,
         secondary_color=EXCLUDED.secondary_color,
         background_color=EXCLUDED.background_color,
         font_family=EXCLUDED.font_family,
         updated_at=NOW()
       RETURNING *`,
      [req.user.tenant_id, primary_color, secondary_color, background_color, font_family]
    );
    res.json(r.rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── DASHBOARD ─────────────────────────────────────────────────────────────────
app.get('/api/dashboard/overview', requireUser, async (req, res) => {
  try {
    const [tvStats, spaceStats, alerts, activity] = await Promise.all([
      query(
        `SELECT
          COUNT(*) FILTER(WHERE last_seen_at > NOW()-INTERVAL '2 minutes') as online,
          COUNT(*) FILTER(WHERE last_seen_at <= NOW()-INTERVAL '2 minutes' OR last_seen_at IS NULL) as offline,
          COUNT(*) as total
         FROM tvs WHERE tenant_id=$1 AND is_paired=true`, [req.user.tenant_id]
      ),
      query(
        `SELECT COUNT(*) FILTER(WHERE content_count=0) as without_content
         FROM (
           SELECT s.id,COUNT(sc.id) as content_count
           FROM spaces s LEFT JOIN space_contents sc ON sc.space_id=s.id AND sc.active=true
           WHERE s.tenant_id=$1 GROUP BY s.id
         ) sub`, [req.user.tenant_id]
      ),
      query(
        'SELECT * FROM alerts WHERE tenant_id=$1 AND resolved=false ORDER BY created_at DESC LIMIT 10',
        [req.user.tenant_id]
      ),
      query(
        'SELECT * FROM activity_logs WHERE tenant_id=$1 ORDER BY created_at DESC LIMIT 10',
        [req.user.tenant_id]
      )
    ]);

    // Check for offline TVs and create alerts
    const offlineTvs = await query(
      `SELECT name FROM tvs WHERE tenant_id=$1 AND is_paired=true
       AND last_seen_at < NOW()-INTERVAL '2 minutes' AND last_seen_at > NOW()-INTERVAL '10 minutes'`,
      [req.user.tenant_id]
    );
    for (const tv of offlineTvs.rows) {
      await createAlert(req.user.tenant_id, 'tv_offline', 'warning',
        `TV "${tv.name}" offline`, `A TV "${tv.name}" está sem sinal há mais de 2 minutos.`);
    }

    res.json({
      tvs: tvStats.rows[0],
      spaces_without_content: parseInt(spaceStats.rows[0]?.without_content || 0),
      alerts: alerts.rows,
      activity: activity.rows
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/alerts', requireUser, async (req, res) => {
  try {
    const r = await query(
      'SELECT * FROM alerts WHERE tenant_id=$1 AND resolved=false ORDER BY created_at DESC LIMIT 20',
      [req.user.tenant_id]
    );
    res.json(r.rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/alerts/:id/resolve', requireUser, async (req, res) => {
  try {
    await query('UPDATE alerts SET resolved=true,resolved_at=NOW() WHERE id=$1 AND tenant_id=$2',
      [req.params.id, req.user.tenant_id]);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/activity', requireUser, async (req, res) => {
  try {
    const r = await query(
      'SELECT * FROM activity_logs WHERE tenant_id=$1 ORDER BY created_at DESC LIMIT 30',
      [req.user.tenant_id]
    );
    res.json(r.rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── START ─────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`\n🚀 PLAY.O API v2 rodando em http://localhost:${PORT}`);
  console.log(`📊 Health: http://localhost:${PORT}/health\n`);
});
