// Package transport owns this agent's network connections to the control
// plane: the one-shot Enroll RPC (this file's neighbor, enroll.go) and,
// from Task 15 on, the long-lived authenticated Connect stream.
package transport

import (
	"context"
	"crypto/tls"
	"net"
	"net/http"
	"net/url"
	"time"

	"golang.org/x/net/http2"

	"github.com/modelhub/agent/gen/modelhub/v1/modelhubv1connect"
)

// httpClient is shared by every RPC. There is no overall timeout on purpose:
// the Connect stream is expected to stay open for hours, and liveness is
// handled by HTTP/2 pings instead.
//
// The client always forces HTTP/2 (Connect's bidirectional streaming
// requires it), but *how* it gets there depends on serverURL's scheme:
//
//   - http://  — a local, unencrypted control plane during development.
//     http2.Transport unconditionally builds a tls.Config for every dial
//     (see its dialClientConn), so DialTLSContext can't tell http from
//     https by checking for a nil *tls.Config — it's never nil. Instead we
//     decide once, from the scheme, and when it's http we override the
//     dial to plain TCP and ignore the tls.Config we're handed. This is
//     "prior knowledge" h2c: the client sends the HTTP/2 connection
//     preface directly, with no cleartext-upgrade dance.
//   - https:// — a real deployment. DialTLSContext is left unset, so
//     http2.Transport does its normal TLS dial and ALPN negotiation.
func httpClient(serverURL string) *http.Client {
	transport := &http2.Transport{
		ReadIdleTimeout: 30 * time.Second,
		PingTimeout:     15 * time.Second,
	}

	if u, err := url.Parse(serverURL); err == nil && u.Scheme == "http" {
		transport.AllowHTTP = true
		transport.DialTLSContext = func(ctx context.Context, network, addr string, _ *tls.Config) (net.Conn, error) {
			var d net.Dialer
			return d.DialContext(ctx, network, addr)
		}
	}

	return &http.Client{Transport: transport}
}

// NewNodeClient builds a NodeService client against serverURL, which must be
// the control plane's agent-facing port (AGENT_PORT, default 3001) — the
// browser-facing port (PORT, default 3000) is plain HTTP/1.1 and cannot
// serve NodeService's h2c/bidi-stream traffic.
func NewNodeClient(serverURL string) modelhubv1connect.NodeServiceClient {
	return modelhubv1connect.NewNodeServiceClient(httpClient(serverURL), serverURL)
}
