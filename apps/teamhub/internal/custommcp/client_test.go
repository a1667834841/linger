package custommcp

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"sync"
	"testing"
	"time"
)

func TestCallSeparatesHandshakeAndToolDeadlines(t *testing.T) {
	client := NewClient(NetworkPublic)
	client.http.Transport = roundTripFunc(func(r *http.Request) (*http.Response, error) {
		var request struct {
			ID     int    `json:"id"`
			Method string `json:"method"`
		}
		if err := json.NewDecoder(r.Body).Decode(&request); err != nil {
			return nil, err
		}
		deadline, ok := r.Context().Deadline()
		if !ok {
			t.Fatalf("no deadline for %s", request.Method)
		}
		remaining := time.Until(deadline)
		reply := &http.Response{
			StatusCode: http.StatusOK,
			Header:     http.Header{"Content-Type": {"application/json"}},
			Body:       http.NoBody,
		}
		result := `{"protocolVersion":"2025-11-25","capabilities":{"tools":{}}}`
		if request.Method == "tools/call" {
			if remaining <= requestTimeout || remaining > toolTimeout {
				t.Fatalf("tool deadline = %s", remaining)
			}
			result = `{"content":[]}`
		} else {
			if remaining <= 0 || remaining > requestTimeout {
				t.Fatalf("handshake deadline = %s", remaining)
			}
			if request.Method == "notifications/initialized" {
				reply.StatusCode = http.StatusAccepted
				return reply, nil
			}
		}
		reply.Body = io.NopCloser(strings.NewReader(fmt.Sprintf(
			`{"jsonrpc":"2.0","id":%d,"result":%s}`, request.ID, result,
		)))
		return reply, nil
	})
	if _, err := client.Call(t.Context(), "https://example.com/mcp", "", "echo", nil); err != nil {
		t.Fatal(err)
	}
}

func TestCallSendsEmptyArgumentsObjectWhenNil(t *testing.T) {
	client := NewClient(NetworkPublic)
	var arguments json.RawMessage
	client.http.Transport = roundTripFunc(func(r *http.Request) (*http.Response, error) {
		var request struct {
			ID     int    `json:"id"`
			Method string `json:"method"`
			Params struct {
				Arguments json.RawMessage `json:"arguments"`
			} `json:"params"`
		}
		if err := json.NewDecoder(r.Body).Decode(&request); err != nil {
			return nil, err
		}
		reply := &http.Response{StatusCode: http.StatusOK, Header: http.Header{"Content-Type": {"application/json"}}, Body: http.NoBody}
		result := `{"protocolVersion":"2025-11-25","capabilities":{"tools":{}}}`
		switch request.Method {
		case "notifications/initialized":
			reply.StatusCode = http.StatusAccepted
			return reply, nil
		case "tools/call":
			arguments = request.Params.Arguments
			result = `{"content":[]}`
		}
		reply.Body = io.NopCloser(strings.NewReader(fmt.Sprintf(`{"jsonrpc":"2.0","id":%d,"result":%s}`, request.ID, result)))
		return reply, nil
	})
	if _, err := client.Call(t.Context(), "https://example.com/mcp", "", "list", nil); err != nil {
		t.Fatal(err)
	}
	if string(arguments) != "{}" {
		t.Fatalf("arguments = %s, want {}", arguments)
	}
}

func TestCallClassifiesHandshakeFailureBeforeDispatch(t *testing.T) {
	client := NewClient(NetworkPublic)
	client.http.Transport = roundTripFunc(func(r *http.Request) (*http.Response, error) {
		return &http.Response{StatusCode: http.StatusUnauthorized, Body: http.NoBody}, nil
	})
	_, err := client.Call(t.Context(), "https://example.com/mcp", "", "echo", nil)
	if !errors.Is(err, ErrUnauthorized) || !errors.Is(err, ErrNotDispatched) {
		t.Fatalf("expected authentication failure before dispatch, got %v", err)
	}
}

func TestDiscoverAndCallStreamableHTTP(t *testing.T) {
	var mu sync.Mutex
	var methods []string
	server := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer test-token" {
			t.Error("missing bearer credentials")
			w.WriteHeader(http.StatusUnauthorized)
			return
		}
		if r.Method == http.MethodDelete {
			w.WriteHeader(http.StatusNoContent)
			return
		}
		var request struct {
			ID     int            `json:"id"`
			Method string         `json:"method"`
			Params map[string]any `json:"params"`
		}
		if err := json.NewDecoder(r.Body).Decode(&request); err != nil {
			t.Errorf("decode request: %v", err)
			w.WriteHeader(http.StatusBadRequest)
			return
		}
		mu.Lock()
		methods = append(methods, request.Method)
		mu.Unlock()
		if request.Method != "initialize" &&
			(r.Header.Get("MCP-Session-Id") != "fixture-session" || r.Header.Get("MCP-Protocol-Version") != "2025-06-18") {
			t.Error("session headers do not reflect negotiated session")
		}
		w.Header().Set("Content-Type", "application/json")
		result := ""
		switch request.Method {
		case "initialize":
			w.Header().Set("MCP-Session-Id", "fixture-session")
			result = `{"protocolVersion":"2025-06-18","capabilities":{"tools":{}}}`
		case "notifications/initialized":
			w.WriteHeader(http.StatusAccepted)
			return
		case "tools/list":
			if request.Params["cursor"] == nil {
				result = `{"tools":[],"nextCursor":"second"}`
			} else {
				if request.Params["cursor"] != "second" {
					t.Error("unexpected cursor")
				}
				result = `{"tools":[{"name":"echo","inputSchema":{"type":"object"}}]}`
			}
		case "tools/call":
			if request.Params["name"] != "echo" || !reflect.DeepEqual(request.Params["arguments"], map[string]any{"text": "hello"}) {
				t.Errorf("unexpected call parameters: %#v", request.Params)
			}
			w.Header().Set("Content-Type", "text/event-stream")
			fmt.Fprint(w, "data: {\"jsonrpc\":\"2.0\",\"method\":\"notifications/progress\"}\n\n")
			fmt.Fprintf(w, "data: {\"jsonrpc\":\"2.0\",\"id\":%d,\ndata: \"result\":{\"content\":[]}}\n\n", request.ID)
			w.(http.Flusher).Flush()
			<-r.Context().Done()
			return
		default:
			t.Errorf("unexpected method %s", request.Method)
			w.WriteHeader(http.StatusBadRequest)
			return
		}
		fmt.Fprintf(w, `{"jsonrpc":"2.0","id":%d,"result":%s}`, request.ID, result)
	}))
	defer server.Close()
	// Only the fixture bypasses the production public-address dialer.
	client := &Client{http: server.Client()}
	client.http.Transport.(*http.Transport).DialContext = func(ctx context.Context, network, _ string) (net.Conn, error) {
		return (&net.Dialer{}).DialContext(ctx, network, server.Listener.Addr().String())
	}
	endpoint := strings.Replace(server.URL, "127.0.0.1", "example.com", 1)
	tools, err := client.Discover(t.Context(), endpoint, "test-token")
	if err != nil || len(tools) != 1 || tools[0].Name != "echo" {
		t.Fatalf("discover = %v, %v", tools, err)
	}
	result, err := client.Call(t.Context(), endpoint, "test-token", "echo", map[string]any{"text": "hello"})
	if err != nil || string(result) != `{"content":[]}` {
		t.Fatalf("call = %s, %v", result, err)
	}
	mu.Lock()
	defer mu.Unlock()
	want := []string{"initialize", "notifications/initialized", "tools/list", "tools/list", "initialize", "notifications/initialized", "tools/call"}
	if !reflect.DeepEqual(methods, want) {
		t.Errorf("methods = %v, want %v", methods, want)
	}
}

func TestRejectPrivateEndpointsAndInsecureBearer(t *testing.T) {
	client := NewClient(NetworkPublic)
	for _, endpoint := range []string{"https://127.0.0.1/mcp", "https://[::ffff:127.0.0.1]/mcp", "https://169.254.169.254/mcp", "http://localhost/mcp"} {
		if _, err := client.Discover(t.Context(), endpoint, ""); !errors.Is(err, ErrInvalid) {
			t.Errorf("discover %s: %v, want invalid", endpoint, err)
		}
	}
	if _, err := client.Discover(t.Context(), "http://example.com/mcp", "test-token"); !errors.Is(err, ErrInvalid) {
		t.Errorf("insecure bearer: %v, want invalid", err)
	}
}

func TestLocalNetworkEndpointValidation(t *testing.T) {
	client := NewClient(NetworkLocal)
	client.http.Transport = roundTripFunc(func(r *http.Request) (*http.Response, error) {
		return &http.Response{StatusCode: http.StatusUnauthorized, Body: http.NoBody}, nil
	})
	for _, test := range []struct {
		host string
		want error
	}{
		{"127.0.0.2", ErrUnauthorized},
		{"[::1]", ErrUnauthorized},
		{"10.0.0.1", ErrUnauthorized},
		{"172.31.0.1", ErrUnauthorized},
		{"192.168.0.1", ErrUnauthorized},
		{"[fd00::1]", ErrUnauthorized},
		{"100.64.0.1", ErrUnauthorized},
		{"8.8.8.8", ErrUnauthorized},
		{"[2606:4700::1111]", ErrUnauthorized},
		{"0.0.0.0", ErrInvalid},
		{"[::]", ErrInvalid},
		{"169.254.169.254", ErrInvalid},
		{"[::ffff:169.254.169.254]", ErrInvalid},
		{"[fe80::1%25lo]", ErrInvalid},
		{"224.0.0.1", ErrInvalid},
		{"[ff02::1]", ErrInvalid},
		{"198.18.0.1", ErrInvalid},
		{"240.0.0.1", ErrInvalid},
		{"192.88.99.1", ErrInvalid},
		{"[64:ff9b::1]", ErrInvalid},
		{"[2001:db8::1%25lo]", ErrInvalid},
		{"[3fff::1]", ErrInvalid},
		{"[4000::1]", ErrInvalid},
	} {
		t.Run(test.host, func(t *testing.T) {
			_, err := client.Discover(t.Context(), "http://"+test.host+"/mcp", "")
			if !errors.Is(err, test.want) {
				t.Fatalf("discover = %v, want %v", err, test.want)
			}
		})
	}
}

func TestLocalHTTPDiscovery(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		wantAuthorization := ""
		if r.URL.Path == "/authenticated" {
			wantAuthorization = "Bearer fixture-token"
		}
		if got := r.Header.Get("Authorization"); got != wantAuthorization {
			t.Errorf("authorization = %q, want %q", got, wantAuthorization)
		}
		var request struct {
			ID     int    `json:"id"`
			Method string `json:"method"`
		}
		if err := json.NewDecoder(r.Body).Decode(&request); err != nil {
			t.Errorf("decode request: %v", err)
			w.WriteHeader(http.StatusBadRequest)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		switch request.Method {
		case "initialize":
			fmt.Fprintf(w, `{"jsonrpc":"2.0","id":%d,"result":{"protocolVersion":"2025-11-25","capabilities":{"tools":{}}}}`, request.ID)
		case "notifications/initialized":
			w.WriteHeader(http.StatusAccepted)
		case "tools/list":
			if r.Header.Get("MCP-Protocol-Version") != protocol {
				t.Error("stateless requests must carry the negotiated protocol")
			}
			fmt.Fprintf(w, `{"jsonrpc":"2.0","id":%d,"result":{"tools":[]}}`, request.ID)
		default:
			t.Errorf("unexpected method %s", request.Method)
			w.WriteHeader(http.StatusBadRequest)
		}
	}))
	defer server.Close()
	client := NewClient(NetworkLocal)
	defer client.http.CloseIdleConnections()
	if tools, err := client.Discover(t.Context(), server.URL, ""); err != nil || len(tools) != 0 {
		t.Fatalf("discover = %v, %v", tools, err)
	}
	for _, host := range []string{"127.0.0.1", "localhost"} {
		endpoint := strings.Replace(server.URL, "127.0.0.1", host, 1) + "/authenticated"
		if tools, err := client.Discover(t.Context(), endpoint, "fixture-token"); err != nil || len(tools) != 0 {
			t.Fatalf("discover from %s = %v, %v", host, tools, err)
		}
		if _, err := NewClient(NetworkPublic).Discover(t.Context(), endpoint, "fixture-token"); !errors.Is(err, ErrInvalid) {
			t.Fatalf("public discovery from %s = %v, want invalid", host, err)
		}
	}
}

func TestLocalHTTPRejectsBearerOutsideLoopback(t *testing.T) {
	client := NewClient(NetworkLocal)
	client.http.Transport = roundTripFunc(func(r *http.Request) (*http.Response, error) {
		t.Errorf("contacted %s with insecure credentials", r.URL)
		return nil, ErrUnavailable
	})
	for _, host := range []string{"192.168.0.1", "100.64.0.1", "[fd00::1]", "example.com", "localhost.example.com"} {
		if _, err := client.Discover(t.Context(), "http://"+host+"/mcp", "fixture-token"); !errors.Is(err, ErrInvalid) {
			t.Errorf("discover from %s = %v, want invalid", host, err)
		}
	}
}

func TestLocalEndpointCannotFollowRedirect(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/mcp" {
			t.Errorf("followed redirect to %s", r.URL.Path)
			w.WriteHeader(http.StatusBadRequest)
			return
		}
		http.Redirect(w, r, "/redirected", http.StatusTemporaryRedirect)
	}))
	defer server.Close()
	client := NewClient(NetworkLocal)
	defer client.http.CloseIdleConnections()
	if _, err := client.Discover(t.Context(), server.URL+"/mcp", "fixture-token"); !errors.Is(err, ErrUnavailable) {
		t.Fatalf("discover after redirect = %v, want unavailable", err)
	}
}

func TestCallReturnsServerRPCError(t *testing.T) {
	const token = "fixture-token"
	tests := []struct {
		name    string
		message string
		want    string
		wantRPC bool
	}{
		{"invalid params", "Invalid arguments:\n expected object", "Invalid arguments:  expected object", true},
		{"echoed token", "bad " + token, "", false},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			client := NewClient(NetworkPublic)
			client.http.Transport = roundTripFunc(func(r *http.Request) (*http.Response, error) {
				var request struct {
					ID     int    `json:"id"`
					Method string `json:"method"`
				}
				if err := json.NewDecoder(r.Body).Decode(&request); err != nil {
					return nil, err
				}
				reply := &http.Response{StatusCode: http.StatusOK, Header: http.Header{"Content-Type": {"application/json"}}, Body: http.NoBody}
				switch request.Method {
				case "notifications/initialized":
					reply.StatusCode = http.StatusAccepted
					return reply, nil
				case "tools/call":
					body, _ := json.Marshal(map[string]any{"jsonrpc": "2.0", "id": request.ID, "error": map[string]any{"code": -32602, "message": tt.message}})
					reply.Body = io.NopCloser(strings.NewReader(string(body)))
					return reply, nil
				}
				reply.Body = io.NopCloser(strings.NewReader(fmt.Sprintf(`{"jsonrpc":"2.0","id":%d,"result":{"protocolVersion":"2025-11-25","capabilities":{"tools":{}}}}`, request.ID)))
				return reply, nil
			})
			_, err := client.Call(t.Context(), "https://example.com/mcp", token, "list", nil)
			var rpc *RPCError
			if got := errors.As(err, &rpc); got != tt.wantRPC {
				t.Fatalf("RPCError = %v (%v), want %v", got, err, tt.wantRPC)
			}
			if !errors.Is(err, ErrUnavailable) {
				t.Fatalf("err = %v, want it to match unavailable", err)
			}
			if tt.wantRPC && (rpc.Code != -32602 || rpc.Message != tt.want) {
				t.Fatalf("rpc = %+v", rpc)
			}
		})
	}
}

type roundTripFunc func(*http.Request) (*http.Response, error)

func (f roundTripFunc) RoundTrip(request *http.Request) (*http.Response, error) {
	return f(request)
}

func TestBearerCannotFollowRedirect(t *testing.T) {
	client := NewClient(NetworkPublic)
	var hosts []string
	client.http.Transport = roundTripFunc(func(r *http.Request) (*http.Response, error) {
		hosts = append(hosts, r.URL.Host)
		if r.Header.Get("Authorization") != "Bearer fixture-token" {
			t.Error("the configured endpoint did not receive the expected authorization")
		}
		return &http.Response{
			StatusCode: http.StatusTemporaryRedirect,
			Header:     http.Header{"Location": {"https://other.example.com/mcp"}},
			Body:       http.NoBody,
		}, nil
	})
	if _, err := client.Discover(t.Context(), "https://example.com/mcp", "fixture-token"); !errors.Is(err, ErrUnavailable) {
		t.Fatalf("discover after redirect = %v", err)
	}
	if !reflect.DeepEqual(hosts, []string{"example.com"}) {
		t.Fatalf("contacted hosts = %v", hosts)
	}
}

func TestBearerIsNotReturnedFromUpstream(t *testing.T) {
	const token = "fixture-token"
	tests := []struct {
		name     string
		method   string
		status   int
		response string
		wantErr  error
	}{
		{"authentication rejection", "initialize", http.StatusUnauthorized, token, ErrUnauthorized},
		{"tool description", "tools/list", http.StatusOK, `{"tools":[{"name":"echo","description":"fixture-token","inputSchema":{"type":"object"}}]}`, ErrUnavailable},
		{"escaped schema key", "tools/list", http.StatusOK, `{"tools":[{"name":"echo","inputSchema":{"type":"object","properties":{"fixture\u002dtoken":{"type":"string"}}}}]}`, ErrUnavailable},
		{"escaped tool result", "tools/call", http.StatusOK, `{"content":[{"type":"text","text":"fixture\u002dtoken"}]}`, ErrUnavailable},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			client := NewClient(NetworkPublic)
			client.http.Transport = roundTripFunc(func(r *http.Request) (*http.Response, error) {
				var request struct {
					ID     int    `json:"id"`
					Method string `json:"method"`
				}
				if err := json.NewDecoder(r.Body).Decode(&request); err != nil {
					return nil, err
				}
				reply := &http.Response{
					StatusCode: http.StatusOK,
					Header:     http.Header{"Content-Type": {"application/json"}},
					Body:       http.NoBody,
				}
				result := `{"protocolVersion":"2025-11-25","capabilities":{"tools":{}}}`
				switch request.Method {
				case tt.method:
					reply.StatusCode = tt.status
					if tt.status != http.StatusOK {
						reply.Body = io.NopCloser(strings.NewReader(tt.response))
						return reply, nil
					}
					result = tt.response
				case "notifications/initialized":
					reply.StatusCode = http.StatusAccepted
					return reply, nil
				case "initialize":
				default:
					t.Errorf("unexpected method %s", request.Method)
					return nil, ErrUnavailable
				}
				reply.Body = io.NopCloser(strings.NewReader(fmt.Sprintf(
					`{"jsonrpc":"2.0","id":%d,"result":%s}`, request.ID, result,
				)))
				return reply, nil
			})
			const endpoint = "https://example.com/mcp"
			var err error
			if tt.method == "tools/call" {
				var result json.RawMessage
				result, err = client.Call(t.Context(), endpoint, token, "echo", map[string]any{})
				if result != nil {
					t.Error("received an upstream result that contains the bearer")
				}
			} else {
				var tools []Tool
				tools, err = client.Discover(t.Context(), endpoint, token)
				if tools != nil {
					t.Error("received upstream tools after credential rejection or disclosure")
				}
			}
			if !errors.Is(err, tt.wantErr) || strings.Contains(err.Error(), token) {
				t.Fatal("expected a sanitized error")
			}
		})
	}
}
