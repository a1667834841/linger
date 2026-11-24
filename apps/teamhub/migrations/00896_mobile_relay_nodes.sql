-- +goose Up
-- The Relay nodes this computer keeps a link to, so a paired phone can reach
-- it through whichever is fastest where the phone is. TeamHub adds the
-- official nodes at start; the Human adds custom ones and turns any of them
-- off. A node only forwards end-to-end encrypted bytes.
CREATE TABLE mobile_relay_nodes (
    id text PRIMARY KEY,
    url text NOT NULL UNIQUE,
    label text NOT NULL,
    kind text NOT NULL CONSTRAINT mobile_relay_nodes_kind_check CHECK (kind = ANY (ARRAY['official'::text, 'custom'::text])),
    enabled boolean NOT NULL DEFAULT true,
    position integer NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now()
);

-- +goose Down
DROP TABLE mobile_relay_nodes;
