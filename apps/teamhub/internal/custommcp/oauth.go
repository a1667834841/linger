package custommcp

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/netip"
	"net/url"
	"regexp"
	"slices"
	"strings"
	"time"
)

var (
	// ErrOAuthRequired identifies a protected MCP resource advertising OAuth.
	ErrOAuthRequired = errors.New("the MCP server requires OAuth authorization")
	// ErrOAuthMetadata identifies an invalid or unsupported OAuth configuration.
	ErrOAuthMetadata = errors.New("invalid or unsupported MCP OAuth metadata")
	// ErrOAuthResponse identifies a rejected authorization response.
	ErrOAuthResponse = errors.New("invalid MCP OAuth authorization response")
	// ErrForbidden distinguishes a forbidden operation from a rejected token.
	ErrForbidden = errors.Join(ErrUnauthorized, errors.New("the MCP operation is forbidden"))
	// ErrOAuthRefreshRejected means the refresh grant or client credentials are no longer valid.
	ErrOAuthRefreshRejected = errors.New("the OAuth server rejected the refresh grant")
	// ErrOAuthRegistrationRequired means the issuer needs pre-registered client credentials.
	ErrOAuthRegistrationRequired = errors.New("the authorization server requires client registration")
	// ErrOAuthBindingChanged identifies metadata that no longer matches the saved client binding.
	ErrOAuthBindingChanged = errors.New("the MCP OAuth issuer or credential endpoint changed")
	// ErrOAuthClientRejected means the authorization server rejected the registered client.
	ErrOAuthClientRejected = errors.New("the authorization server rejected the registered client")
)

const (
	oauthRequestTimeout = 10 * time.Second
	oauthRefreshTimeout = 30 * time.Second
)

// OAuthRegistration identifies how TeamHub obtained the client credentials.
type OAuthRegistration string

const (
	// OAuthRegistrationDynamic identifies a dynamically registered public client.
	OAuthRegistrationDynamic OAuthRegistration = "dynamic"
	// OAuthRegistrationManual identifies owner-supplied client credentials.
	OAuthRegistrationManual OAuthRegistration = "manual"
)

type resourceMetadata struct {
	Resource       string   `json:"resource"`
	Servers        []string `json:"authorization_servers"`
	Scopes         []string `json:"scopes_supported"`
	challengeScope string
}

type authorizationServer struct {
	Issuer         string   `json:"issuer"`
	Authorization  string   `json:"authorization_endpoint"`
	Token          string   `json:"token_endpoint"`
	Register       string   `json:"registration_endpoint"`
	Revoke         string   `json:"revocation_endpoint"`
	PKCE           []string `json:"code_challenge_methods_supported"`
	Grants         []string `json:"grant_types_supported"`
	ResponseTypes  []string `json:"response_types_supported"`
	AuthMethods    []string `json:"token_endpoint_auth_methods_supported"`
	RequiresIssuer bool     `json:"authorization_response_iss_parameter_supported"`
}

// OAuthClient binds the registration to its issuer and redirect URI.
type OAuthClient struct {
	ClientID      string
	Issuer        string
	RedirectURI   string
	TokenURL      string
	RevokeURL     string
	Scope         string
	RequireIssuer bool
	ClientSecret  string
	AuthMethod    string
	Registration  OAuthRegistration
}

// OAuthOptions contains the owner-supplied and attempt-specific authorization parameters.
type OAuthOptions struct {
	Endpoint, RedirectURI, PreregisteredRedirectURI, State, Verifier, RequiredScope string
	ClientID, ClientSecret, ExpectedIssuer                                          string
	PreviousClient                                                                  OAuthClient
}

// OAuthToken holds the access token and the permissions the server granted.
type OAuthToken struct {
	AccessToken  string
	Scope        string
	ExpiresAt    *time.Time
	RefreshToken string
}

// OAuthCallback carries the authorization server's response.
type OAuthCallback struct {
	State      string `json:"state"`
	Code       string `json:"code"`
	Issuer     string `json:"iss"`
	Error      string `json:"error"`
	CallbackID string `json:"callback_id"`
}

// ValidOAuthRedirect permits HTTPS and native loopback redirects.
func ValidOAuthRedirect(raw string) bool {
	target, err := url.Parse(raw)
	if err != nil || target.User != nil || target.Hostname() == "" || strings.Contains(raw, "#") {
		return false
	}
	host := target.Hostname()
	address, _ := netip.ParseAddr(host)
	return target.Scheme == "https" || target.Scheme == "http" && (isLocalhost(host) || address.Unmap().IsLoopback())
}

// InsufficientScopeError carries the MCP resource's structured scope challenge.
type InsufficientScopeError struct {
	Scope string
}

func (e *InsufficientScopeError) Error() string { return "the MCP token needs more permissions" }
func (e *InsufficientScopeError) Unwrap() error { return ErrForbidden }

// StartOAuth discovers and registers a public client for a single authorization attempt.
func (c *Client) StartOAuth(ctx context.Context, options OAuthOptions) (OAuthClient, string, error) {
	discovery, cancel := context.WithTimeout(ctx, oauthRequestTimeout)
	defer cancel()
	resource, err := c.discoverResource(discovery, options.Endpoint)
	if err != nil {
		return OAuthClient{}, "", err
	}
	if options.ExpectedIssuer != "" && options.ExpectedIssuer != resource.Servers[0] {
		return OAuthClient{}, "", ErrOAuthBindingChanged
	}
	server, err := c.discoverAuthorizationServer(discovery, resource.Servers[0])
	cancel()
	if err != nil {
		return OAuthClient{}, "", err
	}
	if previous := options.PreviousClient; previous.ClientSecret != "" &&
		(previous.TokenURL != server.Token || previous.RevokeURL != server.Revoke) {
		return OAuthClient{}, "", ErrOAuthBindingChanged
	}
	client := OAuthClient{
		Issuer: server.Issuer, RedirectURI: options.RedirectURI, TokenURL: server.Token,
		RevokeURL: server.Revoke, RequireIssuer: server.RequiresIssuer, AuthMethod: "none",
	}
	client.Scope = strings.Join(resource.Scopes, " ")
	if resource.challengeScope != "" {
		client.Scope = resource.challengeScope
	}
	if options.RequiredScope != "" {
		if !validOAuthScope(options.RequiredScope) {
			return OAuthClient{}, "", ErrInvalid
		}
		client.Scope = options.RequiredScope
	}
	if options.ClientID != "" {
		client.RedirectURI = options.PreregisteredRedirectURI
		client.ClientID, client.ClientSecret, client.Registration = options.ClientID, options.ClientSecret, OAuthRegistrationManual
		if client.ClientSecret != "" {
			switch {
			case len(server.AuthMethods) == 0 || slices.Contains(server.AuthMethods, "client_secret_basic"):
				client.AuthMethod = "client_secret_basic"
			case slices.Contains(server.AuthMethods, "client_secret_post"):
				client.AuthMethod = "client_secret_post"
			default:
				return OAuthClient{}, "", ErrOAuthMetadata
			}
		} else if len(server.AuthMethods) != 0 && !slices.Contains(server.AuthMethods, "none") {
			return OAuthClient{}, "", ErrOAuthMetadata
		}
	} else if previous := options.PreviousClient; previous.Registration == OAuthRegistrationDynamic &&
		previous.RedirectURI == client.RedirectURI && previous.Issuer == client.Issuer {
		client.ClientID, client.Registration = previous.ClientID, previous.Registration
	} else if server.Register == "" {
		return OAuthClient{}, options.PreregisteredRedirectURI, ErrOAuthRegistrationRequired
	} else {
		if len(server.AuthMethods) != 0 && !slices.Contains(server.AuthMethods, "none") {
			return OAuthClient{}, "", ErrOAuthMetadata
		}
		if err := c.registerOAuth(ctx, server, &client); err != nil {
			return OAuthClient{}, "", err
		}
	}
	authorize, _ := url.Parse(server.Authorization)
	query := authorize.Query()
	challenge := sha256.Sum256([]byte(options.Verifier))
	query.Set("client_id", client.ClientID)
	query.Set("redirect_uri", client.RedirectURI)
	query.Set("response_type", "code")
	query.Set("state", options.State)
	query.Set("code_challenge_method", "S256")
	query.Set("code_challenge", base64.RawURLEncoding.EncodeToString(challenge[:]))
	query.Set("resource", options.Endpoint)
	query.Del("scope")
	if client.Scope != "" {
		query.Set("scope", client.Scope)
	}
	authorize.RawQuery = query.Encode()
	return client, authorize.String(), nil
}

func (c *Client) registerOAuth(ctx context.Context, server authorizationServer, client *OAuthClient) error {
	ctx, cancel := context.WithTimeout(ctx, oauthRequestTimeout)
	defer cancel()
	grants := []string{"authorization_code"}
	if slices.Contains(server.Grants, "refresh_token") {
		grants = append(grants, "refresh_token")
	}
	registration, err := json.Marshal(map[string]any{
		"client_name": "Linger", "redirect_uris": []string{client.RedirectURI},
		"grant_types": grants, "response_types": []string{"code"},
		"token_endpoint_auth_method": "none",
	})
	if err != nil {
		return err
	}
	var registered struct {
		ClientID   string `json:"client_id"`
		AuthMethod string `json:"token_endpoint_auth_method"`
	}
	_, err = c.oauthRequest(ctx, http.MethodPost, server.Register, "application/json", bytes.NewReader(registration), http.StatusCreated, &registered)
	if err != nil {
		return err
	}
	if registered.ClientID == "" || len(registered.ClientID) > 8192 ||
		(registered.AuthMethod != "" && registered.AuthMethod != "none") {
		return ErrOAuthMetadata
	}
	client.ClientID = registered.ClientID
	client.Registration = OAuthRegistrationDynamic
	return nil
}

func (c *Client) discoverResource(ctx context.Context, endpoint string) (resourceMetadata, error) {
	var metadata resourceMetadata
	target, err := c.target(endpoint, true, false)
	if err != nil {
		return metadata, err
	}
	// Probe only initialize so metadata discovery never opens a tool session.
	// A server that also permits anonymous access can still publish well-known metadata.
	probe := strings.NewReader(`{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"` + protocol + `","capabilities":{},"clientInfo":{"name":"linger","version":"1"}}}`)
	session := &session{http: c.http, endpoint: endpoint}
	response, err := session.request(ctx, http.MethodPost, probe)
	if err != nil {
		return metadata, err
	}
	_ = response.Body.Close()
	var challenge map[string]string
	switch response.StatusCode {
	case http.StatusUnauthorized:
		challenge = bearerChallenge(response.Header.Values("WWW-Authenticate"))
	case http.StatusOK:
		session.id = response.Header.Get("Mcp-Session-Id")
		session.close(ctx)
	default:
		return metadata, ErrOAuthMetadata
	}
	if location := challenge["resource_metadata"]; location != "" {
		_, err = c.oauthRequest(ctx, http.MethodGet, location, "", nil, http.StatusOK, &metadata)
	} else {
		wellKnown := target.Scheme + "://" + target.Host + "/.well-known/oauth-protected-resource"
		path := strings.TrimSuffix(target.EscapedPath(), "/")
		status, lookupErr := c.oauthRequest(ctx, http.MethodGet, wellKnown+path, "", nil, http.StatusOK, &metadata)
		err = lookupErr
		if status == http.StatusNotFound && path != "" {
			_, err = c.oauthRequest(ctx, http.MethodGet, wellKnown, "", nil, http.StatusOK, &metadata)
		}
	}
	if err != nil {
		return metadata, err
	}
	if metadata.Resource != endpoint || len(metadata.Servers) == 0 || !validOAuthScope(strings.Join(metadata.Scopes, " ")) {
		return metadata, ErrOAuthMetadata
	}
	metadata.challengeScope = challenge["scope"]
	if !validOAuthScope(metadata.challengeScope) {
		return metadata, ErrOAuthMetadata
	}
	for _, scope := range metadata.Scopes {
		if scope == "" || strings.Contains(scope, " ") {
			return metadata, ErrOAuthMetadata
		}
	}
	return metadata, nil
}

func (c *Client) discoverAuthorizationServer(ctx context.Context, issuer string) (authorizationServer, error) {
	var server authorizationServer
	target, err := c.target(issuer, true, false)
	if err != nil {
		return server, ErrOAuthMetadata
	}
	origin := target.Scheme + "://" + target.Host
	path := strings.TrimSuffix(target.EscapedPath(), "/")
	locations := []string{origin + "/.well-known/oauth-authorization-server" + path, origin + "/.well-known/openid-configuration" + path}
	if path != "" {
		locations = append(locations, origin+path+"/.well-known/openid-configuration")
	}
	for _, location := range locations {
		var status int
		status, err = c.oauthRequest(ctx, http.MethodGet, location, "", nil, http.StatusOK, &server)
		if status != http.StatusNotFound {
			break
		}
	}
	if err != nil {
		return server, err
	}
	if server.Issuer != issuer || !slices.Contains(server.PKCE, "S256") ||
		(len(server.ResponseTypes) != 0 && !slices.Contains(server.ResponseTypes, "code")) ||
		(len(server.Grants) != 0 && !slices.Contains(server.Grants, "authorization_code")) {
		return server, ErrOAuthMetadata
	}
	for _, endpoint := range []string{server.Authorization, server.Token} {
		if _, err := c.target(endpoint, true, true); err != nil {
			return server, ErrOAuthMetadata
		}
	}
	for _, endpoint := range []string{server.Register, server.Revoke} {
		if endpoint == "" {
			continue
		}
		if _, err := c.target(endpoint, true, true); err != nil {
			return server, ErrOAuthMetadata
		}
	}
	return server, nil
}

// ExchangeOAuth validates the response issuer before spending the one-time code.
func (c *Client) ExchangeOAuth(ctx context.Context, client OAuthClient, endpoint, verifier string, response OAuthCallback) (OAuthToken, error) {
	if (client.RequireIssuer || response.Issuer != "") && response.Issuer != client.Issuer {
		return OAuthToken{}, ErrOAuthResponse
	}
	if response.Code == "" && (response.Error == "invalid_client" || response.Error == "unauthorized_client") {
		return OAuthToken{}, ErrOAuthClientRejected
	}
	if response.Error != "" || response.Code == "" || len(response.Code) > 8192 {
		return OAuthToken{}, ErrOAuthResponse
	}
	ctx, cancel := context.WithTimeout(ctx, oauthRequestTimeout)
	defer cancel()
	form := url.Values{
		"grant_type": {"authorization_code"}, "code": {response.Code},
		"redirect_uri": {client.RedirectURI}, "code_verifier": {verifier}, "resource": {endpoint},
	}
	return c.fetchOAuthToken(ctx, client, form, client.Scope)
}

// RefreshOAuth requests a replacement access token using the current refresh token.
func (c *Client) RefreshOAuth(ctx context.Context, client OAuthClient, endpoint, refreshToken, scope string) (OAuthToken, error) {
	ctx, cancel := context.WithTimeout(ctx, oauthRefreshTimeout)
	defer cancel()
	form := url.Values{"grant_type": {"refresh_token"}, "refresh_token": {refreshToken}, "resource": {endpoint}}
	return c.fetchOAuthToken(ctx, client, form, scope)
}

func (c *Client) fetchOAuthToken(ctx context.Context, client OAuthClient, form url.Values, scope string) (OAuthToken, error) {
	var payload struct {
		AccessToken  string  `json:"access_token"`
		TokenType    string  `json:"token_type"`
		ExpiresIn    *int64  `json:"expires_in"`
		Scope        *string `json:"scope"`
		RefreshToken string  `json:"refresh_token"`
	}
	response, err := c.oauthForm(ctx, client.TokenURL, client, form)
	if err != nil {
		return OAuthToken{}, err
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		if response.StatusCode == http.StatusBadRequest || response.StatusCode == http.StatusUnauthorized {
			var failure struct{ Error string }
			if readOAuthJSON(response.Body, &failure) == nil {
				switch failure.Error {
				case "invalid_client", "unauthorized_client":
					return OAuthToken{}, errors.Join(ErrOAuthRefreshRejected, ErrOAuthClientRejected)
				case "invalid_grant", "unsupported_grant_type", "invalid_scope", "access_denied":
					if form.Get("grant_type") == "refresh_token" {
						return OAuthToken{}, ErrOAuthRefreshRejected
					}
				}
			}
		}
		if form.Get("grant_type") == "refresh_token" {
			return OAuthToken{}, ErrUnavailable
		}
		return OAuthToken{}, ErrOAuthResponse
	}
	if err := readOAuthJSON(response.Body, &payload); err != nil {
		return OAuthToken{}, ErrOAuthResponse
	}
	if !strings.EqualFold(payload.TokenType, "Bearer") || len(payload.AccessToken) > 8192 || !bearerToken.MatchString(payload.AccessToken) {
		return OAuthToken{}, ErrOAuthResponse
	}
	token := OAuthToken{AccessToken: payload.AccessToken, Scope: scope, RefreshToken: payload.RefreshToken}
	if payload.Scope != nil {
		token.Scope = *payload.Scope
	}
	if !validOAuthScope(token.Scope) || !scopeWithin(token.Scope, scope) || len(token.RefreshToken) > 8192 ||
		containsToken(token.Scope, token.AccessToken) || containsToken(token.Scope, token.RefreshToken) ||
		containsToken(token.Scope, client.ClientSecret) {
		return OAuthToken{}, ErrOAuthResponse
	}
	if payload.ExpiresIn != nil {
		// Bound the duration before converting seconds to nanoseconds.
		if *payload.ExpiresIn <= 0 || *payload.ExpiresIn > int64((1<<63-1)/time.Second) {
			return OAuthToken{}, ErrOAuthResponse
		}
		expiry := time.Now().UTC().Add(time.Duration(*payload.ExpiresIn) * time.Second)
		token.ExpiresAt = &expiry
	}
	return token, nil
}

// RevokeOAuth sends only the old token to its original revocation endpoint.
func (c *Client) RevokeOAuth(ctx context.Context, client OAuthClient, token, tokenType string) {
	if client.RevokeURL == "" || token == "" {
		return
	}
	ctx, cancel := context.WithTimeout(ctx, 2*time.Second)
	defer cancel()
	form := url.Values{"token": {token}, "token_type_hint": {tokenType}}
	response, err := c.oauthForm(ctx, client.RevokeURL, client, form)
	if err == nil {
		_ = response.Body.Close()
	}
}

func (c *Client) oauthForm(ctx context.Context, endpoint string, client OAuthClient, form url.Values) (*http.Response, error) {
	if client.AuthMethod != "client_secret_basic" {
		form.Set("client_id", client.ClientID)
	}
	if client.AuthMethod == "client_secret_post" {
		form.Set("client_secret", client.ClientSecret)
	}
	return c.doOAuthRequest(ctx, http.MethodPost, endpoint, "application/x-www-form-urlencoded", strings.NewReader(form.Encode()), client)
}

func (c *Client) doOAuthRequest(ctx context.Context, method, endpoint, contentType string, body io.Reader, client OAuthClient) (*http.Response, error) {
	target, err := c.target(endpoint, true, true)
	if err != nil {
		return nil, ErrOAuthMetadata
	}
	req, err := http.NewRequestWithContext(ctx, method, target.String(), body)
	if err != nil {
		return nil, ErrOAuthMetadata
	}
	req.Header.Set("Accept", "application/json")
	if contentType != "" {
		req.Header.Set("Content-Type", contentType)
	}
	if client.AuthMethod == "client_secret_basic" {
		req.SetBasicAuth(url.QueryEscape(client.ClientID), url.QueryEscape(client.ClientSecret))
	}
	response, err := c.http.Do(req)
	if err != nil {
		if errors.Is(err, ErrInvalid) {
			return nil, ErrOAuthMetadata
		}
		return nil, ErrUnavailable
	}
	return response, nil
}

func (c *Client) oauthRequest(ctx context.Context, method, endpoint, contentType string, body io.Reader, expected int, result any) (int, error) {
	response, err := c.doOAuthRequest(ctx, method, endpoint, contentType, body, OAuthClient{})
	if err != nil {
		return 0, err
	}
	defer response.Body.Close()
	if response.StatusCode != expected {
		return response.StatusCode, ErrOAuthMetadata
	}
	if result != nil {
		if err := readOAuthJSON(response.Body, result); err != nil {
			return response.StatusCode, ErrOAuthMetadata
		}
	}
	return response.StatusCode, nil
}

func readOAuthJSON(body io.Reader, result any) error {
	raw, err := io.ReadAll(io.LimitReader(body, (64<<10)+1))
	if err != nil || len(raw) > 64<<10 || json.Unmarshal(raw, result) != nil {
		return ErrOAuthMetadata
	}
	return nil
}

var (
	bearerToken   = regexp.MustCompile(`^[a-zA-Z0-9._~+/-]+=*$`)
	challengePart = regexp.MustCompile(`(?:[^,"\\]|"(?:[^"\\]|\\.)*")+`)
	authParam     = regexp.MustCompile(`^([A-Za-z0-9_!#$%&'*+.^` + "`" + `|~-]+)[ \t]*=[ \t]*(?:"((?:[^"\\]|\\.)*)"|([^ \t"]+))$`)
)

func bearerChallenge(headers []string) map[string]string {
	for _, header := range headers {
		var bearer bool
		params := make(map[string]string)
		for _, part := range challengePart.FindAllString(header, -1) {
			part = strings.TrimSpace(part)
			match := authParam.FindStringSubmatch(part)
			if match == nil {
				if len(params) != 0 {
					return params
				}
				end := strings.IndexAny(part, " \t")
				if end == -1 {
					bearer = strings.EqualFold(part, "Bearer")
					continue
				}
				bearer = strings.EqualFold(part[:end], "Bearer")
				match = authParam.FindStringSubmatch(strings.TrimSpace(part[end:]))
			}
			if !bearer || len(match) == 0 {
				continue
			}
			key := strings.ToLower(match[1])
			if _, duplicate := params[key]; duplicate {
				return nil
			}
			if match[3] != "" {
				params[key] = match[3]
			} else {
				params[key] = strings.NewReplacer(`\\`, `\`, `\"`, `"`).Replace(match[2])
			}
		}
		if len(params) != 0 {
			return params
		}
	}
	return nil
}

func validOAuthScope(scope string) bool {
	return len(scope) <= 4096 && !strings.ContainsFunc(scope, func(r rune) bool {
		return r < 0x20 || r > 0x7e || r == '"' || r == '\\'
	})
}

func scopeWithin(granted, requested string) bool {
	if requested == "" {
		return true
	}
	allowed := strings.Fields(requested)
	for _, scope := range strings.Fields(granted) {
		if !slices.Contains(allowed, scope) {
			return false
		}
	}
	return true
}
