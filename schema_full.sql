-- =============================================
-- PLAY.O — SCHEMA COMPLETO
-- =============================================

CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- TENANTS
CREATE TABLE IF NOT EXISTS tenants (
  id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  company_name  VARCHAR(255) NOT NULL,
  email         VARCHAR(255) UNIQUE NOT NULL,
  plan          VARCHAR(50) NOT NULL DEFAULT 'free',
  active        BOOLEAN NOT NULL DEFAULT true,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- USERS
CREATE TABLE IF NOT EXISTS users (
  id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id     UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  email         VARCHAR(255) UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  name          VARCHAR(255) NOT NULL,
  role          VARCHAR(50) NOT NULL DEFAULT 'admin',
  active        BOOLEAN NOT NULL DEFAULT true,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_users_tenant ON users(tenant_id);
CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);

-- UNITS
CREATE TABLE IF NOT EXISTS units (
  id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id     UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name          VARCHAR(255) NOT NULL,
  address       TEXT,
  active        BOOLEAN NOT NULL DEFAULT true,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_units_tenant ON units(tenant_id);

-- CONTENTS
CREATE TABLE IF NOT EXISTS contents (
  id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id     UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name          VARCHAR(255) NOT NULL,
  type          VARCHAR(50),
  content_type  VARCHAR(50),
  url           TEXT,
  file_url      TEXT,
  duration      INTEGER DEFAULT 10,
  active        BOOLEAN NOT NULL DEFAULT true,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_contents_tenant ON contents(tenant_id);

-- SPACES
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

-- TVS
CREATE TABLE IF NOT EXISTS tvs (
  id                UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id         UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  unit_id           UUID REFERENCES units(id) ON DELETE SET NULL,
  space_id          UUID REFERENCES spaces(id) ON DELETE SET NULL,
  name              VARCHAR(255) NOT NULL,
  device_identifier VARCHAR(255),
  status            VARCHAR(50) DEFAULT 'offline',
  last_seen         TIMESTAMPTZ,
  active            BOOLEAN NOT NULL DEFAULT true,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_tvs_tenant ON tvs(tenant_id);
CREATE INDEX IF NOT EXISTS idx_tvs_space ON tvs(space_id);
CREATE INDEX IF NOT EXISTS idx_tvs_device_id ON tvs(device_identifier) WHERE device_identifier IS NOT NULL;

-- SPACE_CONTENTS
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

-- BRAND SETTINGS
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

-- ALERTS
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

-- ACTIVITY LOGS
CREATE TABLE IF NOT EXISTS activity_logs (
  id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id     UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  type          VARCHAR(50) NOT NULL,
  message       TEXT NOT NULL,
  metadata      JSONB,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_activity_tenant ON activity_logs(tenant_id, created_at DESC);
