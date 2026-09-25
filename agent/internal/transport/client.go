// Package transport owns the agent's connections to the control plane: the
// one-shot Enroll RPC and the long-lived, authenticated Connect stream.
package transport

import (
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"crypto/tls"
	"encoding/base64"
	"fmt"
	"net"
	"net/http"
	"net/url"
	"time"

	"golang.org/x/net/http2"

	"github.com/modelhub/agent/gen/modelhub/v1/modelhubv1connect"
)

// NewNodeClient builds a NodeService client. serverURL must be the control
// plane's agent-facing listener (AGENT_PORT, default 3001), not the browser one.
func NewNodeClient(serverURL string) modelhubv1connect.NodeServiceClient {
	return modelhubv1connect.NewNodeServiceClient(httpClient(serverURL), serverURL)
}

// httpClient always speaks HTTP/2, which Connect's bidi stream needs. For an
// http:// URL that means h2c with prior knowledge: dial plain TCP and ignore
// the tls.Config http2.Transport always hands over. For https:// it does the
// normal TLS + ALPN dial.
//
// No overall timeout: the stream stays open for hours. HTTP/2 pings detect a
// dead connection instead.
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

// AuthHeader builds the value the control plane's authenticateNode verifies:
//
//	ModelHubNode <nodeID>.<unixMillis>.<nonce>.<signature>
//
// where the signature covers the first three fields exactly as they appear
// in the header. The server rejects reused nonces and stale timestamps, so
// build a fresh header for every connection attempt.
func AuthHeader(nodeID string, priv ed25519.PrivateKey, now time.Time) string {
	raw := make([]byte, 16)
	_, _ = rand.Read(raw)
	payload := fmt.Sprintf("%s.%d.%s", nodeID, now.UnixMilli(), base64.RawURLEncoding.EncodeToString(raw))
	signature := base64.RawURLEncoding.EncodeToString(ed25519.Sign(priv, []byte(payload)))
	return "ModelHubNode " + payload + "." + signature
}
