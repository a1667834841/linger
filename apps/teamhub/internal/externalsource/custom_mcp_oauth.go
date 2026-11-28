package externalsource

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"net/url"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/custommcp"
	idgen "github.com/simplexai-labs/linger/apps/teamhub/internal/ids"
)

const customMCPOAuthTTL = 10 * time.Minute

var (
	// ErrCustomMCPOAuthState identifies an expired, consumed, or mismatched authorization attempt.
	ErrCustomMCPOAuthState = errors.New("invalid MCP OAuth state")
	// ErrCustomMCPReauthorization identifies an OAuth connection that needs a new token.
	ErrCustomMCPReauthorization = errors.New("the MCP connection needs reauthorization")
)

type customMCPOwner struct {
	accountID, tenantID, actorID string
}

type customMCPOAuthAttempt struct {
	Connection customMCPOAuthConfig
	Client     custommcp.OAuthClient
	Verifier   string
	CallbackID string
}

// Only persist the proposed configuration. The tool catalog and credentials are verified after exchange.
type customMCPOAuthConfig struct {
	ID, Name, Endpoint, RequestedScope string
	Revision                           int64
}

// CustomMCPOAuthStart identifies the connection and browser URL for this attempt.
type CustomMCPOAuthStart struct {
	ConnectionID     string     `json:"connection_id,omitempty"`
	AuthorizationURL string     `json:"authorization_url,omitempty"`
	ExpiresAt        *time.Time `json:"expires_at,omitempty"`
	RedirectURI      string     `json:"redirect_uri"`
}

// CustomMCPOAuthInput describes the desired connection and optional manual client credentials.
type CustomMCPOAuthInput struct {
	Connection                   CustomMCPConnection
	ClientID                     string
	ClientSecret                 *string
	WebCallback, DesktopCallback string
	RedirectOnly                 bool
}

// StartCustomMCPOAuth registers an authorization attempt for the signed-in owner.
func (s *Service) StartCustomMCPOAuth(ctx context.Context, accountID, tenantID, actorID string, input CustomMCPOAuthInput) (CustomMCPOAuthStart, error) {
	item := input.Connection
	owner := customMCPOwner{accountID, tenantID, actorID}
	config := customMCPOAuthConfig{
		ID: item.ID, Name: strings.TrimSpace(item.Name), Endpoint: strings.TrimSpace(item.Endpoint),
		Revision: item.Revision, RequestedScope: strings.TrimSpace(item.RequestedScope),
	}
	endpointHash := sha256.Sum256([]byte(config.Endpoint))
	callbackID := base64.RawURLEncoding.EncodeToString(endpointHash[:])
	redirectURI := input.DesktopCallback
	if redirectURI == "" {
		redirectURI = input.WebCallback + "?callback_id=" + url.QueryEscape(callbackID)
	} else {
		callbackID = redirectURI[strings.LastIndexByte(redirectURI, '/')+1:]
	}
	result := CustomMCPOAuthStart{RedirectURI: redirectURI}
	if !custommcp.ValidOAuthRedirect(redirectURI) {
		return result, ErrInvalid
	}
	if input.RedirectOnly {
		return result, nil
	}
	if s.customMCP == nil || s.customMCP.box == nil {
		return result, ErrManagedKeyStorageMissing
	}
	if !validCustomMCPName(config.Name) || len(input.ClientID) > 8192 ||
		input.ClientSecret != nil && (len(*input.ClientSecret) > 8192 || input.ClientID == "") {
		return result, ErrInvalid
	}
	var previous customMCPCredentials
	var issuer, endpoint string
	var sealed []byte
	var required *string
	var registrationInvalid bool
	if config.Revision != 0 {
		err := s.pool.QueryRow(ctx, `SELECT m.endpoint,COALESCE(m.oauth_issuer,''),m.oauth_credentials,m.oauth_required_scope,m.oauth_registration_invalid
			FROM custom_mcp_connections m JOIN external_connections c ON c.id=m.connection_id
			WHERE c.id=$1 AND c.account_id=$2 AND m.tenant_id=$3 AND m.owner_actor_id=$4 AND c.revision=$5 AND c.status='active'`,
			config.ID, owner.accountID, owner.tenantID, owner.actorID, config.Revision).Scan(&endpoint, &issuer, &sealed, &required, &registrationInvalid)
		if errors.Is(err, pgx.ErrNoRows) {
			return result, ErrStaleRevision
		}
		if err != nil {
			return result, err
		}
		if endpoint != config.Endpoint {
			issuer, sealed, required = "", nil, nil
		}
	} else {
		config.ID = idgen.New("external_connection")
	}
	if len(sealed) != 0 {
		var err error
		previous, err = s.customMCP.openCredentials(sealed)
		if err != nil {
			return result, err
		}
	}
	state, verifier := oauthRandom(), oauthRandom()
	options := custommcp.OAuthOptions{
		Endpoint: config.Endpoint, RedirectURI: redirectURI, PreregisteredRedirectURI: redirectURI,
		State: state, Verifier: verifier, RequiredScope: config.RequestedScope,
		ClientID: input.ClientID, ExpectedIssuer: issuer, PreviousClient: previous.Client,
	}
	if registrationInvalid && previous.Client.Registration == custommcp.OAuthRegistrationDynamic {
		options.PreviousClient = custommcp.OAuthClient{}
	}
	if options.RequiredScope == "" && required != nil {
		options.RequiredScope = *required
	}
	if input.ClientSecret != nil {
		options.ClientSecret = *input.ClientSecret
	} else if input.ClientID != "" && input.ClientID == previous.Client.ClientID {
		options.ClientSecret = previous.Client.ClientSecret
	}
	client, connectURL, err := s.customMCP.oauth.StartOAuth(ctx, options)
	if errors.Is(err, custommcp.ErrOAuthBindingChanged) {
		return result, errors.Join(err, s.invalidateCustomMCPBinding(ctx, owner, config))
	}
	if err != nil {
		return result, err
	}
	attempt, err := json.Marshal(customMCPOAuthAttempt{config, client, verifier, callbackID})
	if err != nil {
		return CustomMCPOAuthStart{}, err
	}
	sealed, err = s.customMCP.box.Seal(attempt)
	if err != nil {
		return CustomMCPOAuthStart{}, err
	}
	hash := sha256.Sum256([]byte(state))
	expiry := time.Now().UTC().Add(customMCPOAuthTTL)
	_, err = s.pool.Exec(ctx, `WITH expired AS (
		DELETE FROM custom_mcp_oauth_attempts WHERE expires_at <= now()
	) INSERT INTO custom_mcp_oauth_attempts (state_hash,account_id,tenant_id,owner_actor_id,expires_at,encrypted_attempt)
	VALUES ($1,$2,$3,$4,$5,$6)`, hash[:], accountID, tenantID, actorID, expiry, sealed)
	if err != nil {
		return CustomMCPOAuthStart{}, err
	}
	return CustomMCPOAuthStart{ConnectionID: config.ID, AuthorizationURL: connectURL, ExpiresAt: &expiry, RedirectURI: redirectURI}, nil
}

// CompleteCustomMCPOAuth consumes an owner-bound attempt before exchanging its code or saving a token.
func (s *Service) CompleteCustomMCPOAuth(ctx context.Context, accountID, tenantID, actorID string, callback custommcp.OAuthCallback, desktop bool) error {
	if len(callback.State) != 43 || len(callback.CallbackID) > 48 {
		return ErrCustomMCPOAuthState
	}
	if s.customMCP == nil || s.customMCP.box == nil {
		return ErrManagedKeyStorageMissing
	}
	hash := sha256.Sum256([]byte(callback.State))
	var sealed []byte
	err := s.pool.QueryRow(ctx, `DELETE FROM custom_mcp_oauth_attempts
		WHERE state_hash=$1 AND account_id=$2 AND tenant_id=$3 AND owner_actor_id=$4 AND expires_at > now()
		RETURNING encrypted_attempt`, hash[:], accountID, tenantID, actorID).Scan(&sealed)
	if errors.Is(err, pgx.ErrNoRows) {
		return ErrCustomMCPOAuthState
	}
	if err != nil {
		return err
	}
	plaintext, err := s.customMCP.box.Open(sealed)
	if err != nil {
		return err
	}
	var attempt customMCPOAuthAttempt
	if err := json.Unmarshal(plaintext, &attempt); err != nil {
		return err
	}
	if callback.CallbackID != attempt.CallbackID || desktop != (strings.HasPrefix(attempt.Client.RedirectURI, "http://127.0.0.1:") && strings.Contains(attempt.Client.RedirectURI, "/oauth/connector/")) {
		return ErrCustomMCPOAuthState
	}
	owner := customMCPOwner{accountID, tenantID, actorID}
	config := attempt.Connection
	if err := s.checkCustomMCPOAuthRevision(ctx, owner, config); err != nil {
		return err
	}
	token, err := s.customMCP.oauth.ExchangeOAuth(ctx, attempt.Client, config.Endpoint, attempt.Verifier, callback)
	if errors.Is(err, custommcp.ErrOAuthClientRejected) && config.Revision != 0 {
		err = errors.Join(err, s.invalidateCustomMCPRegistration(ctx, config, attempt.Client.ClientID))
	}
	if err != nil {
		return err
	}
	err = s.saveCustomMCPOAuth(ctx, owner, config, attempt.Client, token)
	if err != nil && config.Revision == 0 {
		s.customMCP.revokeOAuthTokens(ctx, attempt.Client, token.AccessToken, token.RefreshToken)
	}
	return err
}

func (s *Service) saveCustomMCPOAuth(ctx context.Context, owner customMCPOwner, config customMCPOAuthConfig, client custommcp.OAuthClient, token custommcp.OAuthToken) error {
	if strings.Contains(config.Name, token.AccessToken) || strings.Contains(config.Endpoint, token.AccessToken) {
		return custommcp.ErrOAuthResponse
	}
	tools, err := s.TestCustomMCP(ctx, config.Endpoint, token.AccessToken)
	if err != nil {
		return err
	}
	if token.ExpiresAt != nil && !token.ExpiresAt.After(time.Now()) {
		return ErrCustomMCPReauthorization
	}
	sealed, err := s.customMCP.box.Seal([]byte(token.AccessToken))
	if err != nil {
		return err
	}
	_, err = s.persistCustomMCP(ctx, owner, CustomMCPConnection{
		ID: config.ID, Name: config.Name, Endpoint: config.Endpoint, Revision: config.Revision,
		AuthMethod: "oauth", TokenExpiresAt: token.ExpiresAt, GrantedScope: token.Scope, RequestedScope: config.RequestedScope,
	}, sealed, tools, customMCPCredentials{Client: client, RefreshToken: token.RefreshToken}, token.AccessToken)
	return err
}

func (s *Service) checkCustomMCPOAuthRevision(ctx context.Context, owner customMCPOwner, config customMCPOAuthConfig) error {
	if config.Revision == 0 {
		return nil
	}
	var found bool
	err := s.pool.QueryRow(ctx, `SELECT EXISTS(
		SELECT 1 FROM custom_mcp_connections m JOIN external_connections c ON c.id=m.connection_id
		WHERE c.id=$1 AND c.account_id=$2 AND m.tenant_id=$3 AND m.owner_actor_id=$4 AND c.revision=$5 AND c.status='active'
	)`, config.ID, owner.accountID, owner.tenantID, owner.actorID, config.Revision).Scan(&found)
	if err == nil && !found {
		return ErrStaleRevision
	}
	return err
}

func oauthRandom() string {
	var random [32]byte
	// crypto/rand.Read never returns an error: it ends the process if the system source fails.
	_, _ = rand.Read(random[:])
	return base64.RawURLEncoding.EncodeToString(random[:])
}

type customMCPCredentials struct {
	Client       custommcp.OAuthClient
	RefreshToken string
}

type customMCPRevocation struct {
	credentials, access []byte
}

func (catalog *customMCPCatalog) sealCredentials(credentials customMCPCredentials) ([]byte, error) {
	payload, err := json.Marshal(credentials)
	if err != nil {
		return nil, err
	}
	return catalog.box.Seal(payload)
}

func (catalog *customMCPCatalog) openCredentials(sealed []byte) (customMCPCredentials, error) {
	var credentials customMCPCredentials
	raw, err := catalog.box.Open(sealed)
	if err == nil {
		err = json.Unmarshal(raw, &credentials)
	}
	return credentials, err
}

func (catalog *customMCPCatalog) revoke(ctx context.Context, old customMCPRevocation, replacementAccess, replacementRefresh string) {
	if catalog.box == nil || len(old.credentials) == 0 {
		return
	}
	credentials, err := catalog.openCredentials(old.credentials)
	if err != nil || credentials.Client.RevokeURL == "" {
		return
	}
	var access string
	if len(old.access) != 0 {
		if plaintext, err := catalog.box.Open(old.access); err == nil && string(plaintext) != replacementAccess {
			access = string(plaintext)
		}
	}
	refresh := credentials.RefreshToken
	if refresh == replacementRefresh {
		refresh = ""
	}
	catalog.revokeOAuthTokens(ctx, credentials.Client, access, refresh)
}

func (catalog *customMCPCatalog) revokeOAuthTokens(ctx context.Context, client custommcp.OAuthClient, access, refresh string) {
	// Revoking a refresh grant can invalidate active tokens for the same client.
	catalog.oauth.RevokeOAuth(context.WithoutCancel(ctx), client, refresh, "refresh_token")
	catalog.oauth.RevokeOAuth(context.WithoutCancel(ctx), client, access, "access_token")
}

func (s *Service) invalidateCustomMCPBinding(ctx context.Context, owner customMCPOwner, config customMCPOAuthConfig) error {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	var id string
	err = tx.QueryRow(ctx, `SELECT c.id
		FROM custom_mcp_connections m JOIN external_connections c ON c.id=m.connection_id
		WHERE c.id=$1 AND c.account_id=$2 AND m.tenant_id=$3 AND m.owner_actor_id=$4 AND c.revision=$5 AND c.status='active'
		FOR UPDATE OF c`, config.ID, owner.accountID, owner.tenantID, owner.actorID, config.Revision).Scan(&id)
	if errors.Is(err, pgx.ErrNoRows) {
		return ErrStaleRevision
	}
	if err != nil {
		return err
	}
	var old customMCPRevocation
	err = tx.QueryRow(ctx, `SELECT oauth_credentials,encrypted_token FROM custom_mcp_connections WHERE connection_id=$1`,
		id).Scan(&old.credentials, &old.access)
	if err != nil {
		return err
	}
	_, err = tx.Exec(ctx, `UPDATE custom_mcp_connections SET encrypted_token=NULL,oauth_credentials=NULL,
		oauth_client_id=NULL,oauth_issuer=NULL,oauth_refreshable=false,oauth_registration=NULL,oauth_registration_invalid=false,
		oauth_required_scope=NULL,oauth_rejected=true WHERE connection_id=$1`, config.ID)
	if err != nil {
		return err
	}
	_, err = tx.Exec(ctx, `UPDATE external_connections SET revision=revision+1,updated_at=now() WHERE id=$1`, config.ID)
	if err != nil {
		return err
	}
	if err := tx.Commit(ctx); err != nil {
		return err
	}
	s.customMCP.revoke(ctx, old, "", "")
	return nil
}

func (s *Service) invalidateCustomMCPRegistration(ctx context.Context, config customMCPOAuthConfig, clientID string) error {
	_, err := s.pool.Exec(ctx, `UPDATE custom_mcp_connections m SET oauth_registration_invalid=true
		FROM external_connections c WHERE c.id=m.connection_id AND c.id=$1 AND c.revision=$2 AND m.oauth_client_id=$3`,
		config.ID, config.Revision, clientID)
	return err
}
