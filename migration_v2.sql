-- =============================================
-- PLAY.O v2 — MIGRATION
-- Adiciona novos conceitos sem quebrar dados existentes
-- Execute no PostgreSQL do Railway
-- =============================================

-- 1. SPACES (novo conceito central)
CREATE TABLE IF NOT EXISTS spaces (
  id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id     UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  unit_id       UUID NOT NULL REFERENCES units(id) ON DELETE CASCADE,
  name          VARCHAR(255) NOT NULL,
  description   TEXT,
  pairing_code  VARCHAR(10) UNIQUE NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_spaces_tenant ON spaces(tenant_id);
CREATE INDEX IF NOT EXISTS idx_spaces_unit ON spaces(unit_id);
CREATE INDEX IF NOT EXISTS idx_spaces_pairing ON spaces(pairing_code);

-- 2. Adicionar space_id nas TVs (mantém compatibilidade)
ALTER TABLE tvs ADD COLUMN IF NOT EXISTS space_id UUID REFERENCES spaces(id) ON DELETE SET NULL;
ALTER TABLE tvs ADD COLUMN IF NOT EXISTS device_identifier VARCHAR(255);
CREATE INDEX IF NOT EXISTS idx_tvs_space ON tvs(space_id);
CREATE INDEX IF NOT EXISTS idx_tvs_device_id ON tvs(device_identifier) WHERE device_identifier IS NOT NULL;

-- 3. SPACE_CONTENTS (substitui playlist_items no novo fluxo)
CREATE TABLE IF NOT EXISTS space_contents (
  id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id     UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  space_id      UUID NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
  content_id    UUID NOT NULL REFERENCES contents(id) ON DELETE CASCADE,
  sort_order    INTEGER NOT NULL DEFAULT 0,
  active        BOOLEAN NOT NULL DEFAULT true,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(space_id, content_id)
);

CREATE INDEX IF NOT EXISTS idx_space_contents_space ON space_contents(space_id);
CREATE INDEX IF NOT EXISTS idx_space_contents_content ON space_contents(content_id);

-- 4. Adicionar tipo announcement e file_url nos contents
ALTER TABLE contents ADD COLUMN IF NOT EXISTS file_url TEXT;
ALTER TABLE contents ADD COLUMN IF NOT EXISTS content_type VARCHAR(50);
-- content_type: 'video', 'image', 'announcement'
-- Migrar type -> content_type para conteúdos existentes
UPDATE contents SET content_type = type WHERE content_type IS NULL;

-- 5. BRAND SETTINGS
CREATE TABLE IF NOT EXISTS brand_settings (
  id                UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id         UUID NOT NULL UNIQUE REFERENCES tenants(id) ON DELETE CASCADE,
  logo_url          TEXT,
  primary_color     VARCHAR(20) DEFAULT '#6C63FF',
  secondary_color   VARCHAR(20) DEFAULT '#8B7FFF',
  background_color  VARCHAR(20) DEFAULT '#07070C',
  font_family       VARCHAR(100) DEFAULT 'Inter',
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 6. ALERTS
CREATE TABLE IF NOT EXISTS alerts (
  id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id     UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  type          VARCHAR(50) NOT NULL,
  severity      VARCHAR(20) NOT NULL DEFAULT 'info',
  title         VARCHAR(255) NOT NULL,
  message       TEXT,
  resolved      BOOLEAN NOT NULL DEFAULT false,
  resolved_at   TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_alerts_tenant ON alerts(tenant_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_alerts_unresolved ON alerts(tenant_id) WHERE resolved = false;

-- 7. ACTIVITY LOGS
CREATE TABLE IF NOT EXISTS activity_logs (
  id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id     UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  type          VARCHAR(50) NOT NULL,
  message       TEXT NOT NULL,
  metadata      JSONB,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_activity_tenant ON activity_logs(tenant_id, created_at DESC);

-- =============================================
-- DONE
-- =============================================
