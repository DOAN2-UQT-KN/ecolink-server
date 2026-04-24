-- Identity service seed
-- Usage: psql "<identity DATABASE_URL>" -f be/scripts/seeds/identity-service-seed.sql

BEGIN;

INSERT INTO roles ("id", "name", "description", "createdAt", "updatedAt", "deletedAt")
VALUES
  ('11111111-1111-1111-1111-111111111111', 'ADMIN', 'Administrator with full access', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z', NULL),
  ('11111111-1111-1111-1111-111111111112', 'USER', 'Standard user with limited access', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z', NULL)
ON CONFLICT ("name") DO NOTHING;

INSERT INTO permission_sets ("id", "name", "description", "permissions", "createdAt", "updatedAt", "deletedAt")
VALUES
  ('11111111-1111-1111-1111-111111111121', 'BASIC_ACCESS', 'Basic access permissions', ARRAY['READ_SELF', 'UPDATE_SELF'], '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z', NULL),
  ('11111111-1111-1111-1111-111111111122', 'ADMIN_ACCESS', 'Administrative permissions', ARRAY['READ_ALL', 'WRITE_ALL', 'MANAGE_USERS'], '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z', NULL)
ON CONFLICT ("name") DO NOTHING;

INSERT INTO role_permission_sets ("id", "roleId", "permissionSetId", "createdAt", "updatedAt", "deletedAt")
VALUES
  ('11111111-1111-1111-1111-111111111131', '11111111-1111-1111-1111-111111111111', '11111111-1111-1111-1111-111111111122', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z', NULL),
  ('11111111-1111-1111-1111-111111111132', '11111111-1111-1111-1111-111111111112', '11111111-1111-1111-1111-111111111121', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z', NULL)
ON CONFLICT ("roleId", "permissionSetId") DO NOTHING;

INSERT INTO users ("id", "email", "name", "password", "avatar", "bio", "emailVerified", "verificationToken", "roleId", "createdAt", "updatedAt", "deletedAt")
VALUES
  ('11111111-1111-1111-1111-111111111141', 'admin@ecolink.local', 'Seed Admin', '$2b$10$seededhashedpasswordplaceholder', NULL, 'Platform administrator', TRUE, NULL, '11111111-1111-1111-1111-111111111111', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z', NULL),
  ('11111111-1111-1111-1111-111111111142', 'user1@ecolink.local', 'Seed User', '$2b$10$seededhashedpasswordplaceholder', NULL, 'Standard seeded user', TRUE, NULL, '11111111-1111-1111-1111-111111111112', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z', NULL)
ON CONFLICT ("email") DO NOTHING;

INSERT INTO auth_tokens ("id", "user_id", "type", "token_hash", "expires_at", "revoked_at", "used_at", "metadata", "created_at", "updated_at")
VALUES
  ('11111111-1111-1111-1111-111111111151', '11111111-1111-1111-1111-111111111142', 'REFRESH', 'seed_refresh_token_hash_user1', '2026-12-31T00:00:00Z', NULL, NULL, '{"source":"seed"}', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')
ON CONFLICT ("token_hash") DO NOTHING;

COMMIT;
