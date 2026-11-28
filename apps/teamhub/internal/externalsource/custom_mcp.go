package externalsource

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"time"
	"unicode"

	"github.com/jackc/pgx/v5"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/custommcp"
	idgen "github.com/simplexai-labs/linger/apps/teamhub/internal/ids"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/secretbox"
)

// CustomMCPAppKey identifies connections whose tools are served by a custom MCP endpoint.
const CustomMCPAppKey = "custom_mcp"

type customMCPCatalog struct {
	client CustomMCPClient
	box    *secretbox.Box
	oauth  *custommcp.Client
}

// CustomMCPClient discovers and invokes tools on behalf of an external connection.
type CustomMCPClient interface {
	Discover(context.Context, string, string) ([]custommcp.Tool, error)
	Call(context.Context, string, string, string, map[string]any) (json.RawMessage, error)
}

// CustomMCPConnection is the owner-visible configuration. It never contains credentials.
type CustomMCPConnection struct {
	ID                  string                      `json:"id"`
	Name                string                      `json:"name"`
	Endpoint            string                      `json:"endpoint"`
	HasToken            bool                        `json:"has_token"`
	Revision            int64                       `json:"revision"`
	Tools               []custommcp.Tool            `json:"tools"`
	AuthMethod          string                      `json:"auth_method"`
	AuthorizationStatus string                      `json:"authorization_status"`
	TokenExpiresAt      *time.Time                  `json:"token_expires_at,omitempty"`
	GrantedScope        string                      `json:"granted_scope,omitempty"`
	RequiredScope       *string                     `json:"required_scope,omitempty"`
	OAuthClientID       string                      `json:"oauth_client_id,omitempty"`
	OAuthRegistration   custommcp.OAuthRegistration `json:"oauth_registration,omitempty"`
	RequestedScope      string                      `json:"requested_scope,omitempty"`
}

// ConfigureCustomMCP installs the client and optional encryption key. The policy configures the default client.
func (s *Service) ConfigureCustomMCP(box *secretbox.Box, client CustomMCPClient, policy custommcp.NetworkPolicy) {
	oauth := custommcp.NewClient(policy)
	if client == nil {
		client = oauth
	}
	s.customMCP = &customMCPCatalog{client: client, box: box, oauth: oauth}
}

// TestCustomMCP discovers tools without saving credentials or calling a tool.
func (s *Service) TestCustomMCP(ctx context.Context, endpoint, token string) ([]custommcp.Tool, error) {
	if s.customMCP == nil {
		return nil, ErrUnavailable
	}
	return s.customMCP.client.Discover(ctx, strings.TrimSpace(endpoint), token)
}

// ListCustomMCP returns only configurations in the current owner's tenant.
func (s *Service) ListCustomMCP(ctx context.Context, tenantID, ownerActorID string) ([]CustomMCPConnection, error) {
	rows, err := s.pool.Query(ctx, `
		SELECT c.id,c.identity_label,m.endpoint,m.encrypted_token IS NOT NULL,c.revision,m.tools,
			m.auth_method,CASE WHEN m.auth_method='oauth' AND
				(m.oauth_rejected OR (NOT m.oauth_refreshable AND m.oauth_expires_at <= now()) OR m.encrypted_token IS NULL)
				THEN 'reauthorization_required' WHEN m.oauth_required_scope IS NOT NULL THEN 'additional_scope_required'
				ELSE 'ready' END,m.oauth_expires_at,COALESCE(m.oauth_scope,''),
				m.oauth_required_scope, CASE WHEN m.oauth_registration='manual' THEN COALESCE(m.oauth_client_id,'') ELSE '' END,
				COALESCE(m.oauth_registration,''),COALESCE(m.oauth_requested_scope,'')
		FROM custom_mcp_connections m JOIN external_connections c ON c.id=m.connection_id
		WHERE m.tenant_id=$1 AND m.owner_actor_id=$2 AND c.status='active'
		ORDER BY c.created_at,c.id`, tenantID, ownerActorID)
	if err != nil {
		return nil, err
	}
	result, err := pgx.CollectRows(rows, func(row pgx.CollectableRow) (CustomMCPConnection, error) {
		var item CustomMCPConnection
		err := row.Scan(&item.ID, &item.Name, &item.Endpoint, &item.HasToken, &item.Revision, &item.Tools,
			&item.AuthMethod, &item.AuthorizationStatus, &item.TokenExpiresAt, &item.GrantedScope,
			&item.RequiredScope, &item.OAuthClientID, &item.OAuthRegistration, &item.RequestedScope)
		return item, err
	})
	if result == nil && err == nil {
		result = []CustomMCPConnection{}
	}
	return result, err
}

// SaveCustomMCP verifies the endpoint before atomically writing its configuration and tool catalog.
func (s *Service) SaveCustomMCP(ctx context.Context, accountID, tenantID, ownerActorID string, item CustomMCPConnection, suppliedToken *string) (CustomMCPConnection, error) {
	if s.customMCP == nil {
		return CustomMCPConnection{}, ErrUnavailable
	}
	item.Name = strings.TrimSpace(item.Name)
	item.Endpoint = strings.TrimSpace(item.Endpoint)
	item.AuthMethod = "bearer"
	var token string
	var sealed []byte
	if suppliedToken != nil {
		token = *suppliedToken
	} else if item.ID != "" {
		err := s.pool.QueryRow(ctx, `SELECT m.encrypted_token FROM custom_mcp_connections m JOIN external_connections c ON c.id=m.connection_id
			WHERE c.id=$1 AND c.revision=$2 AND c.status='active' AND m.tenant_id=$3 AND m.owner_actor_id=$4 AND m.endpoint=$5
				AND m.auth_method='bearer'`,
			item.ID, item.Revision, tenantID, ownerActorID, item.Endpoint).Scan(&sealed)
		if errors.Is(err, pgx.ErrNoRows) {
			return CustomMCPConnection{}, ErrStaleRevision
		}
		if err != nil {
			return CustomMCPConnection{}, err
		}
		if len(sealed) != 0 {
			if s.customMCP.box == nil {
				return CustomMCPConnection{}, ErrManagedKeyStorageMissing
			}
			plaintext, err := s.customMCP.box.Open(sealed)
			if err != nil {
				return CustomMCPConnection{}, err
			}
			token = string(plaintext)
		}
	}
	if !validCustomMCPName(item.Name) ||
		(token != "" && (strings.Contains(item.Name, token) || strings.Contains(item.Endpoint, token))) {
		return CustomMCPConnection{}, ErrInvalid
	}
	if token != "" && len(sealed) == 0 {
		if s.customMCP.box == nil {
			return CustomMCPConnection{}, ErrManagedKeyStorageMissing
		}
		var err error
		sealed, err = s.customMCP.box.Seal([]byte(token))
		if err != nil {
			return CustomMCPConnection{}, err
		}
	}
	tools, err := s.TestCustomMCP(ctx, item.Endpoint, token)
	if err != nil {
		return CustomMCPConnection{}, err
	}
	return s.persistCustomMCP(ctx, customMCPOwner{accountID, tenantID, ownerActorID}, item, sealed, tools, customMCPCredentials{}, token)
}

func validCustomMCPName(name string) bool {
	return name != "" && len(name) <= 160 && !strings.ContainsFunc(name, unicode.IsControl)
}

func (s *Service) persistCustomMCP(ctx context.Context, owner customMCPOwner, item CustomMCPConnection, sealed []byte, tools []custommcp.Tool, credentials customMCPCredentials, token string) (CustomMCPConnection, error) {
	var oauthSealed []byte
	var err error
	client := credentials.Client
	refreshable := credentials.RefreshToken != ""
	if item.AuthMethod == "oauth" {
		oauthSealed, err = s.customMCP.sealCredentials(credentials)
		if err != nil {
			return CustomMCPConnection{}, err
		}
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return CustomMCPConnection{}, err
	}
	defer tx.Rollback(ctx)
	var old customMCPRevocation
	if item.Revision == 0 {
		if item.ID == "" {
			item.ID = idgen.New("external_connection")
		}
		_, err = tx.Exec(ctx, `
			INSERT INTO external_connections
				(id,account_id,provider,upstream_connection_id,status,toolkit_slug,identity_label,active_since,status_checked_at)
			VALUES ($1,$2,$3,$1,'active',$3,$4,now(),now())`, item.ID, owner.accountID, CustomMCPAppKey, item.Name)
		if err == nil {
			_, err = tx.Exec(ctx, `INSERT INTO custom_mcp_connections
				(connection_id,tenant_id,owner_actor_id,endpoint,encrypted_token,tools,auth_method,oauth_client_id,
				 oauth_issuer,oauth_credentials,oauth_expires_at,oauth_scope,oauth_registration,oauth_refreshable,oauth_requested_scope)
				VALUES ($1,$2,$3,$4,$5,$6,$7,NULLIF($8,''),NULLIF($9,''),$10,$11,NULLIF($12,''),NULLIF($13,''),$14,NULLIF($15,''))`,
				item.ID, owner.tenantID, owner.actorID, item.Endpoint, sealed, tools, item.AuthMethod,
				client.ClientID, client.Issuer, oauthSealed, item.TokenExpiresAt, item.GrantedScope, client.Registration, refreshable, item.RequestedScope)
		}
		item.Revision = 1
	} else {
		err = tx.QueryRow(ctx, `
			UPDATE external_connections c SET identity_label=$5,revision=c.revision+1,updated_at=now(),status_checked_at=now()
			FROM custom_mcp_connections m WHERE m.connection_id=c.id AND c.id=$1 AND c.account_id=$2
				AND m.tenant_id=$3 AND m.owner_actor_id=$4 AND c.revision=$6 AND c.status='active'
			RETURNING c.revision, m.oauth_credentials,
				CASE WHEN m.auth_method='oauth' THEN m.encrypted_token END`,
			item.ID, owner.accountID, owner.tenantID, owner.actorID, item.Name, item.Revision).
			Scan(&item.Revision, &old.credentials, &old.access)
		if errors.Is(err, pgx.ErrNoRows) {
			return CustomMCPConnection{}, ErrStaleRevision
		}
		if err == nil {
			err = tx.QueryRow(ctx, `SELECT oauth_credentials, CASE WHEN auth_method='oauth' THEN encrypted_token END
				FROM custom_mcp_connections WHERE connection_id=$1`, item.ID).Scan(&old.credentials, &old.access)
		}
		if err == nil {
			_, err = tx.Exec(ctx, `UPDATE custom_mcp_connections SET endpoint=$2,encrypted_token=$3,tools=$4,
				auth_method=$5,oauth_client_id=NULLIF($6,''),oauth_issuer=NULLIF($7,''),oauth_credentials=$8,
				oauth_expires_at=$9,oauth_scope=NULLIF($10,''),oauth_rejected=false,oauth_required_scope=NULL,
				oauth_registration=NULLIF($11,''),oauth_registration_invalid=false,oauth_refreshable=$12,oauth_requested_scope=NULLIF($13,'') WHERE connection_id=$1`,
				item.ID, item.Endpoint, sealed, tools, item.AuthMethod,
				client.ClientID, client.Issuer, oauthSealed, item.TokenExpiresAt, item.GrantedScope, client.Registration, refreshable, item.RequestedScope)
		}
	}
	if err != nil {
		return CustomMCPConnection{}, mapDatabaseError(err)
	}
	if err := tx.Commit(ctx); err != nil {
		return CustomMCPConnection{}, err
	}
	item.Tools = tools
	item.HasToken = len(sealed) != 0
	item.AuthorizationStatus = "ready"
	s.customMCP.revoke(ctx, old, token, credentials.RefreshToken)
	if client.Registration == custommcp.OAuthRegistrationManual {
		item.OAuthClientID = client.ClientID
	}
	item.OAuthRegistration = client.Registration
	return item, nil
}

// DeleteCustomMCP revokes the connection and removes its encrypted credentials.
func (s *Service) DeleteCustomMCP(ctx context.Context, tenantID, ownerActorID, connectionID string) error {
	var old customMCPRevocation
	err := s.pool.QueryRow(ctx, `WITH revoked AS (
		UPDATE external_connections c SET status='revoked',revision=c.revision+1,updated_at=now()
		FROM custom_mcp_connections m WHERE c.id=m.connection_id AND c.id=$1 AND m.tenant_id=$2 AND m.owner_actor_id=$3
		RETURNING c.id
	) DELETE FROM custom_mcp_connections m USING revoked WHERE m.connection_id=revoked.id
	RETURNING m.oauth_credentials,
		CASE WHEN m.auth_method='oauth' THEN m.encrypted_token END`, connectionID, tenantID, ownerActorID).
		Scan(&old.credentials, &old.access)
	if errors.Is(err, pgx.ErrNoRows) {
		return ErrNotFound
	}
	if err == nil && s.customMCP != nil {
		s.customMCP.revoke(ctx, old, "", "")
	}
	return err
}

// CustomMCPTools loads the catalog at the exact authorized revision.
func (s *Service) CustomMCPTools(ctx context.Context, connection AgentToolConnection) ([]custommcp.Tool, error) {
	var tools []custommcp.Tool
	err := s.pool.QueryRow(ctx, `SELECT m.tools FROM custom_mcp_connections m JOIN external_connections c ON c.id=m.connection_id
		WHERE c.id=$1 AND c.revision=$2 AND c.status='active'
			AND NOT m.oauth_rejected AND (m.oauth_expires_at IS NULL OR m.oauth_expires_at > now() OR m.oauth_refreshable)`,
		connection.ID, connection.Revision).Scan(&tools)
	if errors.Is(err, pgx.ErrNoRows) {
		err = ErrNotActive
	}
	return tools, err
}

// InvokeCustomMCP dispatches a permitted call at the pinned configuration revision.
func (s *Service) InvokeCustomMCP(ctx context.Context, connection AgentToolConnection, name string, arguments map[string]any) (json.RawMessage, error) {
	if s.customMCP == nil {
		return nil, errors.Join(custommcp.ErrNotDispatched, ErrUnavailable)
	}
	access, err := readCustomMCPAccess(ctx, s.pool, connection)
	if err != nil {
		return nil, errors.Join(custommcp.ErrNotDispatched, err)
	}
	if access.oauth {
		if access.rejected || len(access.sealed) == 0 {
			return nil, errors.Join(custommcp.ErrNotDispatched, ErrCustomMCPReauthorization)
		}
		if access.refreshable && access.refreshDue {
			access, err = s.refreshCustomMCP(ctx, connection, access, false)
			if err != nil {
				return nil, errors.Join(custommcp.ErrNotDispatched, err)
			}
		} else if access.expired {
			return nil, errors.Join(custommcp.ErrNotDispatched, ErrCustomMCPReauthorization)
		}
	}
	result, err := s.callCustomMCP(ctx, access, name, arguments)
	if access.oauth && errors.Is(err, custommcp.ErrUnauthorized) && !errors.Is(err, custommcp.ErrForbidden) {
		failed := err
		access, err = s.refreshCustomMCP(ctx, connection, access, true)
		if err != nil {
			return nil, errors.Join(failed, err)
		}
		// HTTP 401 refuses the credentials. Retry once with the replacement token.
		result, err = s.callCustomMCP(ctx, access, name, arguments)
		if errors.Is(err, custommcp.ErrUnauthorized) && !errors.Is(err, custommcp.ErrForbidden) {
			return nil, errors.Join(err, s.markCustomMCPAuthorization(ctx, connection.ID, access.sealed, nil))
		}
	}
	var scope *custommcp.InsufficientScopeError
	if access.oauth && errors.As(err, &scope) {
		return nil, errors.Join(err, s.markCustomMCPAuthorization(ctx, connection.ID, access.sealed, &scope.Scope))
	}
	return result, err
}

func (s *Service) callCustomMCP(ctx context.Context, access customMCPAccess, name string, arguments map[string]any) (json.RawMessage, error) {
	var token []byte
	if len(access.sealed) != 0 {
		if s.customMCP.box == nil {
			return nil, errors.Join(custommcp.ErrNotDispatched, ErrUnavailable)
		}
		var err error
		token, err = s.customMCP.box.Open(access.sealed)
		if err != nil {
			return nil, errors.Join(custommcp.ErrNotDispatched, err)
		}
	}
	return s.customMCP.client.Call(ctx, access.endpoint, string(token), name, arguments)
}
