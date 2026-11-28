-- +goose Up
ALTER TABLE public.custom_mcp_connections
    ADD COLUMN auth_method text NOT NULL DEFAULT 'bearer' CHECK (auth_method IN ('bearer', 'oauth')),
    ADD COLUMN oauth_client_id text,
    ADD COLUMN oauth_issuer text,
    ADD COLUMN oauth_credentials bytea,
    ADD COLUMN oauth_registration text CHECK (oauth_registration IN ('dynamic', 'manual')),
    ADD COLUMN oauth_registration_invalid boolean NOT NULL DEFAULT false,
    ADD COLUMN oauth_refreshable boolean NOT NULL DEFAULT false,
    ADD COLUMN oauth_expires_at timestamptz,
    ADD COLUMN oauth_scope text,
    ADD COLUMN oauth_requested_scope text,
    ADD COLUMN oauth_rejected boolean NOT NULL DEFAULT false,
    ADD COLUMN oauth_required_scope text;

CREATE TABLE public.custom_mcp_oauth_attempts (
    state_hash bytea PRIMARY KEY,
    account_id text NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
    tenant_id text NOT NULL,
    owner_actor_id text NOT NULL,
    expires_at timestamptz NOT NULL,
    encrypted_attempt bytea NOT NULL,
    FOREIGN KEY (owner_actor_id, tenant_id) REFERENCES public.actors(id, tenant_id) ON DELETE CASCADE
);

CREATE INDEX custom_mcp_oauth_attempts_expiry_idx ON public.custom_mcp_oauth_attempts (expires_at);

-- +goose Down
-- +goose StatementBegin
DO $$ BEGIN
    RAISE EXCEPTION 'custom MCP OAuth migration is forward-only';
END $$;
-- +goose StatementEnd
