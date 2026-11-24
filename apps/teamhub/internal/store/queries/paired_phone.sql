-- name: CreateMobilePairingInvite :one
INSERT INTO mobile_pairing_invites (id, account_id, token_hash, expires_at)
VALUES ($1, $2, $3, now() + sqlc.arg(lifetime)::interval)
RETURNING id, expires_at;

-- name: ConsumeMobilePairingInvite :one
-- Spends one live invite; a used or expired invite returns no row.
UPDATE mobile_pairing_invites
SET consumed_at = now()
WHERE token_hash = $1 AND consumed_at IS NULL AND expires_at > now()
RETURNING id, account_id;

-- name: CreatePendingPairedPhone :one
INSERT INTO paired_phones (id, account_id, public_key, name, platform, confirmation_code)
VALUES ($1, $2, $3, $4, $5, $6)
RETURNING id;

-- name: CreatePhoneSession :one
-- A device Session has no idle renewal; the Gateway replaces it before it
-- expires.
INSERT INTO auth_sessions (id, account_id, token_hash, expires_at)
VALUES ($1, $2, $3, now() + sqlc.arg(lifetime)::interval)
RETURNING id;

-- name: GetPairedPhoneByKey :one
SELECT p.id, p.account_id, p.session_id, p.removed_at, p.approved_at, p.confirmation_code, p.created_at,
       s.token_hash AS session_token_hash, s.expires_at AS session_expires_at,
       s.revoked_at AS session_revoked_at
FROM paired_phones p
LEFT JOIN auth_sessions s ON s.id = p.session_id
WHERE p.public_key = $1
FOR UPDATE OF p;

-- name: DeletePendingPairedPhone :exec
DELETE FROM paired_phones WHERE id = $1 AND approved_at IS NULL;

-- name: ApprovePairedPhone :one
UPDATE paired_phones
SET approved_at = now(), session_id = $3, last_seen_at = now()
WHERE id = $1 AND account_id = $2 AND approved_at IS NULL AND removed_at IS NULL
  AND created_at > now() - sqlc.arg(pending_lifetime)::interval
RETURNING id;

-- name: ReplacePairedPhoneSession :exec
UPDATE paired_phones SET session_id = $2, last_seen_at = now() WHERE id = $1;

-- name: RevokePhoneSession :exec
UPDATE auth_sessions
SET revoked_at = coalesce(revoked_at, now()),
    revoked_reason = CASE WHEN revoked_at IS NULL THEN sqlc.arg(reason)::text ELSE revoked_reason END
WHERE id = $1;

-- name: TouchPairedPhone :exec
UPDATE paired_phones SET last_seen_at = now() WHERE id = $1 AND removed_at IS NULL;

-- name: ListPairedPhones :many
-- Pending phones older than the pending lifetime are left out; Resume or
-- the next approval attempt deletes them.
SELECT id, name, platform, created_at, last_seen_at, approved_at, confirmation_code,
       (push_grant IS NOT NULL)::boolean AS push_enabled
FROM paired_phones
WHERE account_id = $1 AND removed_at IS NULL
  AND (approved_at IS NOT NULL OR created_at > now() - sqlc.arg(pending_lifetime)::interval)
ORDER BY created_at DESC, id;

-- name: RemovePairedPhone :one
UPDATE paired_phones
SET removed_at = now(), push_grant = NULL, push_service_url = NULL
WHERE id = $1 AND account_id = $2 AND removed_at IS NULL
RETURNING session_id;

-- name: PairedPhoneExists :one
SELECT EXISTS (SELECT 1 FROM paired_phones WHERE id = $1 AND account_id = $2) AS exists;

-- name: GetPairedPhoneBySession :one
SELECT id, account_id FROM paired_phones
WHERE session_id = $1 AND removed_at IS NULL;

-- name: SetPairedPhonePushGrant :exec
UPDATE paired_phones
SET push_grant = sqlc.narg(push_grant), push_service_url = sqlc.narg(push_service_url)
WHERE id = $1 AND removed_at IS NULL;

-- name: ClearPairedPhonePushGrant :exec
-- The Push Service refused the grant: it expired or the phone uninstalled.
UPDATE paired_phones SET push_grant = NULL, push_service_url = NULL
WHERE id = $1 AND push_grant = $2;

-- name: ListPushGrantsForTenant :many
-- The phones of the Account that owns a Space's Human.
SELECT p.id, p.push_grant::text AS push_grant, p.push_service_url::text AS push_service_url
FROM paired_phones p
JOIN actors human ON human.account_id = p.account_id AND human.kind = 'human'
WHERE human.tenant_id = $1 AND p.removed_at IS NULL AND p.approved_at IS NOT NULL
  AND p.push_grant IS NOT NULL;

-- name: GetMobilePushMessage :one
-- The facts a push job needs about one published Message: whether Another Me
-- wrote it in the Human's direct chat, and whether it asks the Human to
-- decide something.
SELECT e.tenant_id, e.room_id, e.event_id, m.id AS message_id, m.message_kind,
       (r.direct_human_actor_id IS NOT NULL
        AND m.author_actor_id = r.direct_agent_actor_id
        AND EXISTS (
            SELECT 1 FROM agent_registrations a
            WHERE a.actor_id = m.author_actor_id AND a.agent_type = 'anotherme'
        ))::boolean AS from_another_me_direct,
       EXISTS (
           SELECT 1 FROM decisions d
           JOIN actors human ON human.id = d.decider_actor_id AND human.kind = 'human'
           WHERE d.message_id = m.id AND d.status = 'pending'
       )::boolean AS asks_decision
FROM room_events e
JOIN messages m ON m.id = e.resource_id
JOIN rooms r ON r.id = e.room_id
WHERE e.event_id = $1 AND e.event_type = 'message.created' AND r.deleted_at IS NULL;
