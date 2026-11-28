package integration_test

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/simplexai-labs/linger/apps/teamhub/internal/config"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/custommcp"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/externalsource"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/secretbox"
)

func TestCustomMCPOAuthCallbackRefreshAndReauthorization(t *testing.T) {
	allowParallelIntegrationTest(t)
	key := base64.StdEncoding.EncodeToString(bytes.Repeat([]byte{11}, 32))
	env, alice, _, _ := newAgentCLIIdentity(t, withConfig(func(cfg *config.Config) {
		cfg.ExternalApps.CustomMCPNetwork = custommcp.NetworkLocal
		cfg.ExternalApps.SecretEncryptionKey = key
	}))
	bob := seedPeerHuman(t, env)
	var origin string
	var registrations, exchanges, refreshes, revocations atomic.Int32
	var removeRefresh, rejectAccess, requireScope, rejectRefresh atomic.Bool
	as := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch r.URL.Path {
		case "/resource":
			_, _ = fmt.Fprintf(w, `{"resource":%q,"authorization_servers":[%q],"scopes_supported":["read"]}`, origin+"/mcp", origin)
		case "/.well-known/oauth-authorization-server":
			_, _ = fmt.Fprintf(w, `{"issuer":%q,"authorization_endpoint":%q,"token_endpoint":%q,"registration_endpoint":%q,"revocation_endpoint":%q,"code_challenge_methods_supported":["S256"],"authorization_response_iss_parameter_supported":true,"token_endpoint_auth_methods_supported":["none"],"grant_types_supported":["authorization_code","refresh_token"]}`,
				origin, origin+"/authorize", origin+"/token", origin+"/register", origin+"/revoke")
		case "/register":
			registrations.Add(1)
			w.WriteHeader(http.StatusCreated)
			_, _ = fmt.Fprint(w, `{"client_id":"fixture-client"}`)
		case "/token":
			_ = r.ParseForm()
			if r.Form.Get("resource") != origin+"/mcp" || r.Form.Get("client_id") != "fixture-client" {
				t.Error("token request missing resource or client binding")
			}
			w.Header().Set("Content-Type", "application/json")
			if r.Form.Get("grant_type") == "authorization_code" {
				n := exchanges.Add(1)
				fields := map[string]any{"access_token": fmt.Sprintf("access-%d", n), "expires_in": 3600, "token_type": "Bearer"}
				if !removeRefresh.Load() {
					fields["refresh_token"] = "refresh-original"
				}
				_ = json.NewEncoder(w).Encode(fields)
				return
			}
			n := refreshes.Add(1)
			if rejectRefresh.Load() {
				w.WriteHeader(http.StatusBadRequest)
				_, _ = fmt.Fprint(w, `{"error":"invalid_grant"}`)
				return
			}
			want := "refresh-original"
			if n > 1 {
				want = fmt.Sprintf("refresh-rotated-%d", n-1)
			}
			if r.Form.Get("refresh_token") != want {
				t.Error("refresh did not use the current refresh token")
			}
			time.Sleep(100 * time.Millisecond)
			_, _ = fmt.Fprintf(w, `{"access_token":"access-refreshed-%d","refresh_token":"refresh-rotated-%d","expires_in":3600,"token_type":"Bearer"}`, n, n)
		case "/revoke":
			revocations.Add(1)
			w.WriteHeader(http.StatusServiceUnavailable)
		case "/mcp":
			token := r.Header.Get("Authorization")
			if token == "" || rejectAccess.Load() && (token == "Bearer access-refreshed-1" || token == "Bearer access-3") {
				w.Header().Set("WWW-Authenticate", fmt.Sprintf(`Bearer resource_metadata="%s/resource"`, origin))
				w.WriteHeader(http.StatusUnauthorized)
				return
			}
			var message struct {
				ID     int
				Method string
			}
			if json.NewDecoder(r.Body).Decode(&message) != nil {
				w.WriteHeader(http.StatusBadRequest)
				return
			}
			switch message.Method {
			case "initialize":
				_, _ = fmt.Fprintf(w, `{"jsonrpc":"2.0","id":%d,"result":{"protocolVersion":"2025-11-25","capabilities":{"tools":{}}}}`, message.ID)
			case "notifications/initialized":
				w.WriteHeader(http.StatusAccepted)
			case "tools/list":
				_, _ = fmt.Fprintf(w, `{"jsonrpc":"2.0","id":%d,"result":{"tools":[{"name":"echo","inputSchema":{"type":"object"}}]}}`, message.ID)
			case "tools/call":
				if requireScope.Load() {
					w.Header().Set("WWW-Authenticate", `Bearer error="insufficient_scope", scope="read write"`)
					w.WriteHeader(http.StatusForbidden)
					return
				}
				_, _ = fmt.Fprintf(w, `{"jsonrpc":"2.0","id":%d,"result":{"content":[]}}`, message.ID)
			default:
				t.Error("unexpected MCP method")
				w.WriteHeader(http.StatusBadRequest)
			}
		default:
			http.NotFound(w, r)
		}
	}))
	defer as.Close()
	origin = as.URL

	const base = "/v0/custom-mcp-connections"
	input := map[string]any{"name": "OAuth fixture", "endpoint": origin + "/mcp"}
	code, _, body := env.request(alice, http.MethodPost, base, input, "")
	if code != http.StatusConflict || !bytes.Contains(body, []byte("CUSTOM_MCP_OAUTH_REQUIRED")) {
		t.Fatalf("OAuth was not detected: %d %s", code, body)
	}
	start := func() (*url.URL, string) {
		t.Helper()
		code, _, body := env.request(alice, http.MethodPost, base+"/oauth/start", input, "")
		if code != http.StatusOK {
			t.Fatalf("start OAuth: %d %s", code, body)
		}
		var attempt externalsource.CustomMCPOAuthStart
		decode(t, body, &attempt)
		authorize, err := url.Parse(attempt.AuthorizationURL)
		if err != nil {
			t.Fatal(err)
		}
		return authorize, attempt.ConnectionID
	}
	finish := func(who *http.Client, authorization *url.URL, state, issuer string, want int, errorCode string) {
		t.Helper()
		redirect, err := url.Parse(authorization.Query().Get("redirect_uri"))
		if err != nil {
			t.Fatal(err)
		}
		query := redirect.Query()
		query.Set("state", state)
		query.Set("iss", issuer)
		query.Set("code", "fixture-code")
		redirect.RawQuery = query.Encode()
		method := http.MethodGet
		target := redirect.RequestURI()
		var payload any
		if strings.HasPrefix(redirect.Path, "/oauth/connector/") {
			method, target = http.MethodPost, base+"/oauth/callback"
			payload = custommcp.OAuthCallback{State: state, Issuer: issuer, Code: "fixture-code", CallbackID: strings.TrimPrefix(redirect.Path, "/oauth/connector/")}
		}
		code, _, body := env.request(who, method, target, payload, "")
		if code != want || !bytes.Contains(body, []byte(errorCode)) {
			t.Fatalf("callback: got %d %s, want %d %s", code, body, want, errorCode)
		}
	}
	ctx := t.Context()
	auth, _ := start()
	if _, err := env.pool.Exec(ctx, "UPDATE custom_mcp_oauth_attempts SET expires_at=now()"); err != nil {
		t.Fatal(err)
	}
	finish(alice, auth, auth.Query().Get("state"), origin, http.StatusBadRequest, "CUSTOM_MCP_OAUTH_STATE_INVALID")
	auth, _ = start()
	finish(alice, auth, auth.Query().Get("state"), origin+"/other", http.StatusBadRequest, "CUSTOM_MCP_OAUTH_RESPONSE_INVALID")
	auth, id := start()
	state := auth.Query().Get("state")
	finish(alice, auth, strings.Repeat("x", 43), origin, http.StatusBadRequest, "CUSTOM_MCP_OAUTH_STATE_INVALID")
	finish(bob, auth, state, origin, http.StatusBadRequest, "CUSTOM_MCP_OAUTH_STATE_INVALID")
	if exchanges.Load() != 0 {
		t.Fatal("invalid callbacks reached token exchange")
	}
	finish(alice, auth, state, origin, http.StatusOK, "Authorization complete")
	finish(alice, auth, state, origin, http.StatusBadRequest, "CUSTOM_MCP_OAUTH_STATE_INVALID")

	connector := func() externalsource.CustomMCPConnection {
		t.Helper()
		code, _, body := env.request(alice, http.MethodGet, base, nil, "")
		if code != http.StatusOK || bytes.Contains(body, []byte("access-1")) || bytes.Contains(body, []byte("refresh-original")) {
			t.Fatalf("list returned a token or an error: %d", code)
		}
		var listed struct {
			Connections []externalsource.CustomMCPConnection
		}
		decode(t, body, &listed)
		if len(listed.Connections) != 1 {
			t.Fatalf("listed %d connectors", len(listed.Connections))
		}
		return listed.Connections[0]
	}
	checkStatus := func(want string) {
		t.Helper()
		if status := connector().AuthorizationStatus; status != want {
			t.Fatalf("authorization status = %q, want %q", status, want)
		}
	}
	checkStatus("ready")
	var sealedAccess, sealedCredentials []byte
	err := env.pool.QueryRow(ctx, `SELECT encrypted_token,oauth_credentials FROM custom_mcp_connections WHERE connection_id=$1`, id).Scan(&sealedAccess, &sealedCredentials)
	if err != nil || len(sealedAccess) == 0 || len(sealedCredentials) == 0 ||
		bytes.Contains(sealedAccess, []byte("access-1")) || bytes.Contains(sealedCredentials, []byte("refresh-original")) {
		t.Fatalf("OAuth credentials not sealed: %v", err)
	}
	grantPath := "/v0/external-connections/" + id + "/agent-grants/actor_acme_official"
	if code, _, body := env.request(alice, http.MethodPut, grantPath, map[string]bool{"granted": true}, ""); code != http.StatusOK {
		t.Fatalf("grant: %d %s", code, body)
	}
	box, err := secretbox.New(key)
	if err != nil {
		t.Fatal(err)
	}
	service := externalsource.New(env.pool, nil)
	service.ConfigureCustomMCP(box, nil, custommcp.NetworkLocal)
	connection := externalsource.AgentToolConnection{ID: id, AgentActorID: "actor_acme_official", Revision: 1}
	if err := env.pool.QueryRow(ctx, `SELECT revision FROM external_connection_agent_grants WHERE connection_id=$1 AND agent_actor_id=$2`, id, connection.AgentActorID).Scan(&connection.GrantRevision); err != nil {
		t.Fatal(err)
	}
	invoke := func() error {
		_, err := service.InvokeCustomMCP(ctx, connection, "echo", map[string]any{})
		return err
	}
	advanceExpiry := func() {
		t.Helper()
		if _, err := env.pool.Exec(ctx, `UPDATE custom_mcp_connections SET oauth_expires_at=now()+interval '4 minutes' WHERE connection_id=$1`, id); err != nil {
			t.Fatal(err)
		}
	}
	advanceExpiry()
	var concurrent sync.WaitGroup
	for range 8 {
		concurrent.Go(func() {
			if err := invoke(); err != nil {
				t.Errorf("concurrent refreshed call: %v", err)
			}
		})
	}
	concurrent.Wait()
	if refreshes.Load() != 1 {
		t.Fatalf("concurrent calls refreshed %d times", refreshes.Load())
	}
	rejectAccess.Store(true)
	if err := invoke(); err != nil || refreshes.Load() != 2 {
		t.Fatalf("401 refresh did not retry once: %v", err)
	}
	requireScope.Store(true)
	var required *custommcp.InsufficientScopeError
	if err := invoke(); !errors.As(err, &required) {
		t.Fatalf("expected structured scope challenge: %v", err)
	}
	checkStatus("additional_scope_required")
	if scope := connector().RequiredScope; scope == nil || *scope != "read write" {
		t.Fatal("scope challenge was not exposed")
	}
	input["id"], input["revision"] = id, connection.Revision
	auth, _ = start()
	if auth.Query().Get("scope") != "read write" || registrations.Load() != 3 {
		t.Fatal("scope upgrade did not reuse the saved registration")
	}
	requireScope.Store(false)
	finish(alice, auth, auth.Query().Get("state"), origin, http.StatusOK, "Authorization complete")
	connection.Revision++
	checkStatus("ready")
	rejectRefresh.Store(true)
	advanceExpiry()
	if err := invoke(); !errors.Is(err, externalsource.ErrCustomMCPReauthorization) {
		t.Fatalf("invalid_grant: %v", err)
	}
	checkStatus("reauthorization_required")
	input["revision"] = connection.Revision
	input["desktop_callback_url"] = "http://127.0.0.1:32123/oauth/connector/" + strings.Repeat("a", 48)
	removeRefresh.Store(true)
	rejectAccess.Store(false)
	auth, _ = start()
	finish(alice, auth, auth.Query().Get("state"), origin, http.StatusNoContent, "")
	connection.Revision++
	rejectAccess.Store(true)
	if err := invoke(); !errors.Is(err, externalsource.ErrCustomMCPReauthorization) {
		t.Fatalf("401 without refresh token: %v", err)
	}
	checkStatus("reauthorization_required")
	if _, err := env.pool.Exec(ctx, `UPDATE custom_mcp_connections SET oauth_expires_at=now(),oauth_rejected=false WHERE connection_id=$1`, id); err != nil {
		t.Fatal(err)
	}
	checkStatus("reauthorization_required")
	if err := invoke(); !errors.Is(err, externalsource.ErrCustomMCPReauthorization) {
		t.Fatalf("expired access token: %v", err)
	}
	before := revocations.Load()
	if code, _, body := env.request(alice, http.MethodDelete, base+"/"+id, nil, ""); code != http.StatusNoContent {
		t.Fatalf("delete OAuth connector: %d %s", code, body)
	}
	if revocations.Load() <= before {
		t.Fatal("delete did not attempt revocation")
	}
}
