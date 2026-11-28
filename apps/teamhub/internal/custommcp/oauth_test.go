package custommcp

import (
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"net/url"
	"reflect"
	"sync"
	"sync/atomic"
	"testing"
)

func TestOAuthDiscoveryRegistrationAndExchange(t *testing.T) {
	var origin string
	var registrations, exchanges atomic.Int32
	const verifier = "pkce-verifier"
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch r.URL.Path {
		case "/mcp":
			w.Header().Set("WWW-Authenticate", fmt.Sprintf(`Basic realm="other", Bearer scope="read write", resource_metadata="%s/resource"`, origin))
			w.WriteHeader(http.StatusUnauthorized)
		case "/resource":
			_ = json.NewEncoder(w).Encode(resourceMetadata{Resource: origin + "/mcp", Servers: []string{origin, "https://ignored.example"}, Scopes: []string{"all"}})
		case "/.well-known/oauth-authorization-server":
			_ = json.NewEncoder(w).Encode(authorizationServer{
				Issuer: origin, Authorization: origin + "/authorize", Token: origin + "/token", Register: origin + "/register",
				PKCE: []string{"S256"}, AuthMethods: []string{"none"}, Grants: []string{"authorization_code", "refresh_token"},
				RequiresIssuer: true,
			})
		case "/register":
			registrations.Add(1)
			var fields struct {
				Method    string   `json:"token_endpoint_auth_method"`
				Grants    []string `json:"grant_types"`
				Redirects []string `json:"redirect_uris"`
			}
			if json.NewDecoder(r.Body).Decode(&fields) != nil || fields.Method != "none" ||
				!reflect.DeepEqual(fields.Grants, []string{"authorization_code", "refresh_token"}) ||
				!reflect.DeepEqual(fields.Redirects, []string{"https://web.example/callback"}) {
				t.Error("invalid registration")
			}
			w.WriteHeader(http.StatusCreated)
			_, _ = fmt.Fprint(w, `{"client_id":"registered"}`)
		case "/token":
			exchanges.Add(1)
			if err := r.ParseForm(); err != nil || r.Form.Get("resource") != origin+"/mcp" ||
				r.Form.Get("code_verifier") != verifier || r.Form.Get("client_id") != "registered" ||
				r.Form.Get("redirect_uri") != "https://web.example/callback" || r.Form.Get("code") != "provider-code" {
				t.Error("invalid token exchange parameters")
			}
			_, _ = fmt.Fprint(w, `{"access_token":"access-fixture","refresh_token":"refresh-fixture","token_type":"Bearer","expires_in":3600,"scope":"read"}`)
		default:
			http.NotFound(w, r)
		}
	}))
	defer server.Close()
	origin = server.URL
	client := NewClient(NetworkLocal)
	options := OAuthOptions{
		Endpoint: origin + "/mcp", RedirectURI: "https://web.example/callback", State: "state", Verifier: verifier,
	}
	if _, err := client.Discover(t.Context(), options.Endpoint, ""); !errors.Is(err, ErrOAuthRequired) {
		t.Fatalf("expected OAuth challenge: %v", err)
	}
	registration, authorization, err := client.StartOAuth(t.Context(), options)
	if err != nil {
		t.Fatal(err)
	}
	target, err := url.Parse(authorization)
	if err != nil {
		t.Fatal(err)
	}
	q := target.Query()
	challenge := sha256.Sum256([]byte(verifier))
	if q.Get("code_challenge") != base64.RawURLEncoding.EncodeToString(challenge[:]) || q.Get("code_challenge_method") != "S256" ||
		q.Get("scope") != "read write" || q.Get("state") != "state" || q.Get("resource") != options.Endpoint {
		t.Error("invalid authorization parameters")
	}
	for _, issuer := range []string{"", "https://different.example"} {
		if _, err := client.ExchangeOAuth(t.Context(), registration, options.Endpoint, verifier, OAuthCallback{Code: "provider-code", Issuer: issuer}); !errors.Is(err, ErrOAuthResponse) {
			t.Fatalf("accepted wrong issuer: %v", err)
		}
	}
	if exchanges.Load() != 0 {
		t.Fatal("invalid issuer reached the token endpoint")
	}
	token, err := client.ExchangeOAuth(t.Context(), registration, options.Endpoint, verifier, OAuthCallback{Code: "provider-code", Issuer: origin})
	if err != nil || token.AccessToken != "access-fixture" || token.RefreshToken != "refresh-fixture" || token.ExpiresAt == nil || token.Scope != "read" {
		t.Fatalf("exchange did not produce the expected credentials: %v", err)
	}
	options.PreviousClient = registration
	options.RequiredScope = "read admin"
	_, authorization, err = client.StartOAuth(t.Context(), options)
	target, _ = url.Parse(authorization)
	if err != nil || registrations.Load() != 1 || target.Query().Get("scope") != "read admin" {
		t.Fatalf("reauthorization did not reuse registration and request the selected scopes: %v", err)
	}
	options.ExpectedIssuer = "https://different.example"
	if _, _, err := client.StartOAuth(t.Context(), options); !errors.Is(err, ErrOAuthBindingChanged) {
		t.Fatalf("expected an issuer binding error: %v", err)
	}
}

func TestOAuthWellKnownFallbackAndManualClient(t *testing.T) {
	for _, method := range []string{"client_secret_basic", "client_secret_post", "none"} {
		t.Run(method, func(t *testing.T) {
			var requests []string
			var mu sync.Mutex
			var origin string
			const clientID, secret = "client: id", "secret&value"
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				mu.Lock()
				requests = append(requests, r.URL.Path)
				mu.Unlock()
				w.Header().Set("Content-Type", "application/json")
				switch r.URL.Path {
				case "/mcp":
					w.Header().Set("WWW-Authenticate", "Bearer")
					w.WriteHeader(http.StatusUnauthorized)
				case "/.well-known/oauth-protected-resource":
					_ = json.NewEncoder(w).Encode(resourceMetadata{Resource: origin + "/mcp", Servers: []string{origin + "/tenant"}, Scopes: []string{"read"}})
				case "/tenant/.well-known/openid-configuration":
					_ = json.NewEncoder(w).Encode(authorizationServer{Issuer: origin + "/tenant", Authorization: origin + "/authorize", Token: origin + "/token", PKCE: []string{"S256"}, AuthMethods: []string{method}})
				case "/token":
					_ = r.ParseForm()
					user, password, basic := r.BasicAuth()
					switch method {
					case "client_secret_basic":
						if !basic || user != url.QueryEscape(clientID) || password != url.QueryEscape(secret) || r.Form.Has("client_secret") || r.Form.Has("client_id") {
							t.Error("expected form-encoded HTTP Basic credentials")
						}
					case "client_secret_post":
						if basic || r.Form.Get("client_id") != clientID || r.Form.Get("client_secret") != secret {
							t.Error("expected credentials in the token form")
						}
					case "none":
						if basic || r.Form.Get("client_id") != clientID || r.Form.Has("client_secret") {
							t.Error("the public client sent authentication credentials")
						}
					}
					if r.Form.Get("grant_type") == "refresh_token" {
						w.WriteHeader(http.StatusBadRequest)
						_, _ = fmt.Fprint(w, `{"error":"invalid_grant"}`)
						return
					}
					_, _ = fmt.Fprint(w, `{"token_type":"Bearer","access_token":"manual-access"}`)
				default:
					http.NotFound(w, r)
				}
			}))
			defer server.Close()
			origin = server.URL
			client := NewClient(NetworkLocal)
			options := OAuthOptions{Endpoint: origin + "/mcp", PreregisteredRedirectURI: "https://web.example/callback"}
			_, redirect, err := client.StartOAuth(t.Context(), options)
			if !errors.Is(err, ErrOAuthRegistrationRequired) || redirect != options.PreregisteredRedirectURI {
				t.Fatalf("unexpected registration requirement: %v", err)
			}
			mu.Lock()
			want := []string{"/mcp", "/.well-known/oauth-protected-resource/mcp", "/.well-known/oauth-protected-resource", "/.well-known/oauth-authorization-server/tenant", "/.well-known/openid-configuration/tenant", "/tenant/.well-known/openid-configuration"}
			if !reflect.DeepEqual(requests, want) {
				t.Errorf("discovery requests = %v, want %v", requests, want)
			}
			mu.Unlock()
			options.ClientID = clientID
			if method != "none" {
				options.ClientSecret = secret
			}
			registration, authorize, err := client.StartOAuth(t.Context(), options)
			if err != nil || registration.AuthMethod != method || registration.Registration != OAuthRegistrationManual || registration.Scope != "read" {
				t.Fatalf("manual registration failed: %v", err)
			}
			target, _ := url.Parse(authorize)
			if target.Query().Get("client_secret") != "" {
				t.Fatal("client secret was sent to the browser")
			}
			if _, err := client.ExchangeOAuth(t.Context(), registration, options.Endpoint, "verifier", OAuthCallback{Code: "code"}); err != nil {
				t.Fatal(err)
			}
			if _, err := client.RefreshOAuth(t.Context(), registration, options.Endpoint, "retired", "read"); !errors.Is(err, ErrOAuthRefreshRejected) {
				t.Fatalf("invalid_grant was not classified: %v", err)
			}
		})
	}
}

func TestOAuthRejectsUnsafeMetadataAndRedirects(t *testing.T) {
	t.Run("public AS cannot dial private networks", func(t *testing.T) {
		for _, issuer := range []string{"http://127.0.0.1", "https://127.0.0.1", "https://192.168.1.1", "https://localhost"} {
			if _, err := NewClient(NetworkPublic).discoverAuthorizationServer(t.Context(), issuer); !errors.Is(err, ErrOAuthMetadata) {
				t.Fatalf("private AS was not rejected: %v", err)
			}
		}
	})
	for _, scenario := range []string{"wrong resource", "wrong issuer", "redirect", "first issuer only"} {
		t.Run(scenario, func(t *testing.T) {
			var origin string
			var deniedCalls atomic.Int32
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				switch r.URL.Path {
				case "/mcp":
					w.Header().Set("WWW-Authenticate", fmt.Sprintf(`Bearer resource_metadata="%s/resource"`, origin))
					w.WriteHeader(http.StatusUnauthorized)
				case "/resource":
					if scenario == "redirect" {
						http.Redirect(w, r, origin+"/denied", http.StatusTemporaryRedirect)
						return
					}
					metadata := resourceMetadata{Resource: origin + "/mcp", Servers: []string{origin}}
					if scenario == "wrong resource" {
						metadata.Resource = origin + "/other"
					}
					if scenario == "first issuer only" {
						metadata.Servers = []string{"https://192.0.2.1", origin}
					}
					_ = json.NewEncoder(w).Encode(metadata)
				case "/.well-known/oauth-authorization-server":
					if scenario != "wrong issuer" {
						deniedCalls.Add(1)
					}
					_ = json.NewEncoder(w).Encode(authorizationServer{Issuer: origin + "/other"})
				default:
					deniedCalls.Add(1)
				}
			}))
			defer server.Close()
			origin = server.URL
			if _, _, err := NewClient(NetworkLocal).StartOAuth(t.Context(), OAuthOptions{Endpoint: origin + "/mcp"}); !errors.Is(err, ErrOAuthMetadata) {
				t.Fatalf("OAuth discovery returned %v", err)
			}
			if deniedCalls.Load() != 0 {
				t.Fatal("discovery continued past unsafe metadata")
			}
		})
	}
}

func TestOAuthCredentialRequestsDoNotFollowRedirects(t *testing.T) {
	var redirected atomic.Int32
	sink := httptest.NewServer(http.HandlerFunc(func(http.ResponseWriter, *http.Request) {
		redirected.Add(1)
	}))
	defer sink.Close()
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, sink.URL, http.StatusTemporaryRedirect)
	}))
	defer server.Close()
	client := NewClient(NetworkLocal)
	registration := OAuthClient{
		ClientID: "manual-client", ClientSecret: "fixture-secret", AuthMethod: "client_secret_post",
		TokenURL: server.URL + "/token", RevokeURL: server.URL + "/revoke",
	}
	if _, err := client.ExchangeOAuth(t.Context(), registration, server.URL+"/mcp", "fixture-verifier", OAuthCallback{Code: "fixture-code"}); !errors.Is(err, ErrOAuthResponse) {
		t.Fatalf("redirected token exchange returned %v", err)
	}
	if _, err := client.RefreshOAuth(t.Context(), registration, server.URL+"/mcp", "fixture-refresh", ""); !errors.Is(err, ErrUnavailable) {
		t.Fatalf("redirected refresh returned %v", err)
	}
	client.RevokeOAuth(t.Context(), registration, "fixture-access", "access_token")
	if redirected.Load() != 0 {
		t.Fatal("a credential request followed the redirect")
	}
}
