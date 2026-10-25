-- Runs once when the dev database volume is created (docker-compose.dev.yml).
-- Mirrors what a production DBA provisions before the first migration (ADR 0005):
-- extensions, and a LOGIN role for the application that is a member of rocky_app.
-- Changing this file requires recreating the volume: `pnpm dev:down -v` (dev data is lost).
CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- Group role the migrations manage (created here so the login role can join it before the
-- first migration runs; migration 0001 verifies its attributes and adds the grants).
CREATE ROLE rocky_app NOLOGIN INHERIT;
-- The application's dev login. Development-only password; .env.example uses it.
CREATE ROLE rocky_app_dev LOGIN PASSWORD 'rocky-dev-only' INHERIT IN ROLE rocky_app;
