package externalsource

import (
	"bytes"
	"context"
	"errors"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/custommcp"
)

type customMCPAccess struct {
	endpoint, scope                                   string
	sealed, credentials                               []byte
	oauth, rejected, expired, refreshDue, refreshable bool
}

type customMCPQueryer interface {
	QueryRow(context.Context, string, ...any) pgx.Row
}

func readCustomMCPAccess(ctx context.Context, db customMCPQueryer, connection AgentToolConnection) (customMCPAccess, error) {
	var access customMCPAccess
	err := db.QueryRow(ctx, `SELECT m.endpoint, m.encrypted_token, m.auth_method='oauth', m.oauth_rejected,
		COALESCE(m.oauth_expires_at <= now(),false), COALESCE(m.oauth_expires_at <= now()+interval '5 minutes',false),
		m.oauth_refreshable, m.oauth_credentials, COALESCE(m.oauth_scope,'')
		FROM custom_mcp_connections m JOIN external_connections c ON c.id=m.connection_id
		JOIN external_connection_agent_grants g ON g.connection_id=c.id AND g.tenant_id=m.tenant_id AND g.represented_human_actor_id=m.owner_actor_id
		WHERE c.id=$1 AND c.revision=$2 AND c.status='active' AND g.agent_actor_id=$3 AND g.revision=$4 AND g.status='active'`,
		connection.ID, connection.Revision, connection.AgentActorID, connection.GrantRevision).
		Scan(&access.endpoint, &access.sealed, &access.oauth, &access.rejected, &access.expired, &access.refreshDue,
			&access.refreshable, &access.credentials, &access.scope)
	if errors.Is(err, pgx.ErrNoRows) {
		err = ErrNotActive
	}
	return access, err
}

func (s *Service) refreshCustomMCP(ctx context.Context, connection AgentToolConnection, previous customMCPAccess, rejected bool) (customMCPAccess, error) {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return customMCPAccess{}, err
	}
	defer tx.Rollback(ctx)
	// Take the same lock as edits and deletes, then read the latest token in a new statement.
	// Concurrent requests that saw the old token reuse whichever replacement won the lock.
	var id string
	err = tx.QueryRow(ctx, `SELECT id FROM external_connections WHERE id=$1 AND revision=$2 AND status='active' FOR UPDATE`,
		connection.ID, connection.Revision).Scan(&id)
	if errors.Is(err, pgx.ErrNoRows) {
		return customMCPAccess{}, ErrNotActive
	}
	if err != nil {
		return customMCPAccess{}, err
	}
	current, err := readCustomMCPAccess(ctx, tx, connection)
	if err != nil {
		return customMCPAccess{}, err
	}
	if current.rejected || len(current.sealed) == 0 {
		return customMCPAccess{}, ErrCustomMCPReauthorization
	}
	if !bytes.Equal(current.sealed, previous.sealed) {
		return current, nil
	}
	if !current.refreshable {
		if rejected {
			return customMCPAccess{}, rejectCustomMCPRefresh(ctx, tx, connection.ID, false)
		}
		return customMCPAccess{}, ErrCustomMCPReauthorization
	}
	if s.customMCP.box == nil {
		return customMCPAccess{}, ErrManagedKeyStorageMissing
	}
	credentials, err := s.customMCP.openCredentials(current.credentials)
	if err != nil {
		return customMCPAccess{}, err
	}
	// A canceled tool request must not discard a successful, rotating refresh response.
	refreshCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), 32*time.Second)
	defer cancel()
	token, err := s.customMCP.oauth.RefreshOAuth(refreshCtx, credentials.Client, current.endpoint, credentials.RefreshToken, current.scope)
	if errors.Is(err, custommcp.ErrOAuthRefreshRejected) || errors.Is(err, custommcp.ErrOAuthResponse) {
		return customMCPAccess{}, rejectCustomMCPRefresh(refreshCtx, tx, connection.ID, errors.Is(err, custommcp.ErrOAuthClientRejected))
	}
	if err != nil {
		if !rejected && !current.expired && errors.Is(err, custommcp.ErrUnavailable) {
			return current, nil
		}
		return customMCPAccess{}, err
	}
	if token.RefreshToken != "" {
		credentials.RefreshToken = token.RefreshToken
	}
	current.sealed, err = s.customMCP.box.Seal([]byte(token.AccessToken))
	if err != nil {
		return customMCPAccess{}, err
	}
	current.credentials, err = s.customMCP.sealCredentials(credentials)
	if err != nil {
		return customMCPAccess{}, err
	}
	_, err = tx.Exec(refreshCtx, `UPDATE custom_mcp_connections SET encrypted_token=$2,oauth_credentials=$3,
		oauth_expires_at=$4,oauth_scope=NULLIF($5,'') WHERE connection_id=$1`,
		connection.ID, current.sealed, current.credentials, token.ExpiresAt, token.Scope)
	if err != nil {
		return customMCPAccess{}, err
	}
	if err := tx.Commit(refreshCtx); err != nil {
		return customMCPAccess{}, err
	}
	current.expired, current.refreshDue, current.scope = false, false, token.Scope
	return current, nil
}

func rejectCustomMCPRefresh(ctx context.Context, tx pgx.Tx, id string, registrationInvalid bool) error {
	_, err := tx.Exec(ctx, `UPDATE custom_mcp_connections SET oauth_rejected=true,
		oauth_registration_invalid=oauth_registration_invalid OR $2 WHERE connection_id=$1`, id, registrationInvalid)
	if err != nil {
		return err
	}
	if err := tx.Commit(ctx); err != nil {
		return err
	}
	return ErrCustomMCPReauthorization
}

func (s *Service) markCustomMCPAuthorization(ctx context.Context, id string, sealed []byte, scope *string) error {
	if scope != nil {
		if token, err := s.customMCP.box.Open(sealed); err == nil && strings.Contains(*scope, string(token)) {
			scope = new(string)
		}
	}
	ctx, cancel := context.WithTimeout(context.WithoutCancel(ctx), 2*time.Second)
	defer cancel()
	// A late response for the old credential cannot change the replacement's status.
	_, err := s.pool.Exec(ctx, `UPDATE custom_mcp_connections SET
		oauth_rejected=oauth_rejected OR $3::text IS NULL,
		oauth_required_scope=COALESCE($3,oauth_required_scope)
		WHERE connection_id=$1 AND encrypted_token=$2 AND auth_method='oauth'`, id, sealed, scope)
	return err
}
