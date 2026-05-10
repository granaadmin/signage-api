const express = require('express');
const cors = require('cors');
const path = require('path');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3001;

// ─── CORS: aceita qualquer origem em desenvolvimento ──────────────────────────
app.use(cors({
  origin: (origin, callback) => {
    // Aceita qualquer origem — necessário porque o painel é um arquivo HTML
    // Em produção, você pode restringir para seu domínio específico
    callback(null, true);
  },
  credentials: true,
}));

// ─── Body parsing ─────────────────────────────────────────────────────────────
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

// Serve arquivos de upload (vídeos, imagens)
const UPLOAD_DIR = process.env.UPLOAD_DIR || './uploads';
const uploadPath = path.resolve(UPLOAD_DIR);
console.log('Upload dir:', uploadPath);
app.use('/uploads', express.static(uploadPath));

// ─── Rotas ────────────────────────────────────────────────────────────────────
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString(), version: '1.0.0' });
});

app.use('/api/auth',      require('./routes/auth'));
app.use('/api/units',     require('./routes/units'));
app.use('/api/tvs',       require('./routes/tvs'));
app.use('/api/contents',  require('./routes/contents'));
app.use('/api/playlists', require('./routes/playlists'));
app.use('/api/analytics', require('./routes/analytics'));

// Rota de debug — lista tabelas do banco (só em dev)
if (process.env.NODE_ENV !== 'production') {
  const { query } = require('./db');
  app.get('/debug/tvs', async (req, res) => {
    const { query } = require('./db');
    const result = await query('SELECT id, name, unit_id, is_paired, pairing_code, last_seen_at, token IS NOT NULL as has_token FROM tvs ORDER BY created_at DESC');
    res.json(result.rows);
  });

  app.get('/debug/playlists', async (req, res) => {
    const { query } = require('./db');
    const result = await query('SELECT p.id, p.name, p.unit_id, p.is_default, COUNT(pi.id) as items FROM playlists p LEFT JOIN playlist_items pi ON pi.playlist_id = p.id GROUP BY p.id ORDER BY p.created_at DESC');
    res.json(result.rows);
  });

  app.get('/debug/tables', async (req, res) => {
    try {
      const result = await query(`
        SELECT table_name FROM information_schema.tables
        WHERE table_schema = 'public' ORDER BY table_name
      `);
      res.json(result.rows.map(r => r.table_name));
    } catch (err) {
      res.json({ error: err.message });
    }
  });
}

// ─── Handler de erros ─────────────────────────────────────────────────────────
app.use((err, req, res, next) => {
  console.error('Erro não tratado:', err.message);
  res.status(500).json({ error: err.message || 'Erro interno do servidor' });
});

// ─── Start ────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`\n🚀 Signage API rodando em http://localhost:${PORT}`);
  console.log(`📊 Health check: http://localhost:${PORT}/health`);
  console.log(`🗄️  Tabelas: http://localhost:${PORT}/debug/tables`);
  console.log(`🌍 Ambiente: ${process.env.NODE_ENV || 'development'}\n`);
});
