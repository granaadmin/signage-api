-- =============================================
-- PLAY.O — SCHEMA COMPLETO (derivado do index.js)
-- =============================================

CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

DROP TABLE IF EXISTS activity_logs, alerts, brand_settings, space_contents, tvs, contents, spaces, units, users, tenants CASCADE;

-- TENANTS
CREATE TABLE tenants (
  id                UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  name              VARCHAR(255) NOT NULL,
  slug              VARCHAR(255) UNIQUE,
  plan              VARCHAR(50) NOT NULL DEFAULT 'starter',
  max_units         INTEGER DEFAULT 5,
  max_tvs_per_unit  INTEGER DEFAULT 10,
  storage_gb        INTEGER DEFAULT 10,
  is_active         BOOLEAN NOT NULL DEFAULT true,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- USERS
CREATE TABLE users (
  id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id     UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  email         VARCHAR(255) UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  name          VARCHAR(255) NOT NULL,
  role          VARCHAR(50) NOT NULL DEFAULT 'owner',
  is_active     BOOLEAN NOT NULL DEFAULT true,
  last_login_at TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_users_tenant ON users(tenant_id);
CREATE INDEX idx_users_email ON users(email);

-- UNITS
CREATE TABLE units (
  id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id     UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name          VARCHAR(255) NOT NULL,
  city          VARCHAR(255),
  description   TEXT,
  is_active     BOOLEAN NOT NULL DEFAULT true,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_units_tenant ON units(tenant_id);

-- SPACES
CREATE TABLE spaces (
  id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id     UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  unit_id       UUID NOT NULL REFERENCES units(id) ON DELETE CASCADE,
  name          VARCHAR(255) NOT NULL,
  description   TEXT,
  pairing_code  VARCHAR(10) UNIQUE NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_spaces_tenant ON spaces(tenant_id);
CREATE INDEX idx_spaces_unit ON spaces(unit_id);
CREATE INDEX idx_spaces_pairing ON spaces(pairing_code);

-- CONTENTS
CREATE TABLE contents (
  id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id     UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name          VARCHAR(255) NOT NULL,
  type          VARCHAR(50),
  content_type  VARCHAR(50),
  file_path     TEXT,
  file_url      TEXT,
  file_size     BIGINT,
  duration      INTEGER,
  template_data JSONB,
  created_by    UUID REFERENCES users(id) ON DELETE SET NULL,
  is_active     BOOLEAN NOT NULL DEFAULT true,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_contents_tenant ON contents(tenant_id);

-- TVS
CREATE TABLE tvs (
  id                UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id         UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  unit_id           UUID REFERENCES units(id) ON DELETE SET NULL,
  space_id          UUID REFERENCES spaces(id) ON DELETE SET NULL,
  name              VARCHAR(255) NOT NULL,
  is_paired         BOOLEAN NOT NULL DEFAULT false,
  token             TEXT,
  pairing_code      VARCHAR(20),
  device_identifier VARCHAR(255),
  last_seen_at      TIMESTAMPTZ,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_tvs_tenant ON tvs(tenant_id);
CREATE INDEX idx_tvs_space ON tvs(space_id);

-- SPACE_CONTENTS (usa "active", não "is_active")
CREATE TABLE space_contents (
  id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id     UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  space_id      UUID NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
  content_id    UUID NOT NULL REFERENCES contents(id) ON DELETE CASCADE,
  sort_order    INTEGER NOT NULL DEFAULT 0,
  active        BOOLEAN NOT NULL DEFAULT true,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(space_id, content_id)
);
CREATE INDEX idx_space_contents_space ON space_contents(space_id);
CREATE INDEX idx_space_contents_content ON space_contents(content_id);

-- BRAND SETTINGS
CREATE TABLE brand_settings (
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
CREATE TABLE alerts (
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
CREATE INDEX idx_alerts_tenant ON alerts(tenant_id, created_at DESC);

-- ACTIVITY LOGS
CREATE TABLE activity_logs (
  id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id     UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  type          VARCHAR(50) NOT NULL,
  message       TEXT NOT NULL,
  metadata      JSONB,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_activity_tenant ON activity_logs(tenant_id, created_at DESC);
