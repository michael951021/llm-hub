package transport

import (
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"net/http"
	"net/http/httptest"
	"testing"

	"connectrpc.com/connect"
	"golang.org/x/net/http2"
	"golang.org/x/net/http2/h2c"

	modelhubv1 "github.com/modelhub/agent/gen/modelhub/v1"
	"github.com/modelhub/agent/gen/modelhub/v1/modelhubv1connect"
	"github.com/modelhub/agent/internal/inventory"
)

type stubNodeService struct {
	modelhubv1connect.UnimplementedNodeServiceHandler
	lastRequest *modelhubv1.EnrollRequest
	err         error
}

func (s *stubNodeService) Enroll(
	_ context.Context, req *connect.Request[modelhubv1.EnrollRequest],
) (*connect.Response[modelhubv1.EnrollResponse], error) {
	if s.err != nil {
		return nil, s.err
	}
	s.lastRequest = req.Msg
	return connect.NewResponse(&modelhubv1.EnrollResponse{
		NodeId:  "node-123",
		OrgId:   "org_abc",
		OrgName: "Test Fleet",
	}), nil
}

// newStubServer starts an httptest server that speaks h2c (cleartext
// HTTP/2). The production client (see client.go) forces HTTP/2 with prior
// knowledge over a plain http:// URL, so a stub server that only speaks
// HTTP/1.1 (a bare httptest.NewServer) would fail to connect. Wrapping the
// mux in h2c.NewHandler lets the standard net/http server recognize the
// HTTP/2 connection preface and upgrade in place.
func newStubServer(t *testing.T, stub *stubNodeService) string {
	t.Helper()
	mux := http.NewServeMux()
	mux.Handle(modelhubv1connect.NewNodeServiceHandler(stub))
	server := httptest.NewServer(h2c.NewHandler(mux, &http2.Server{}))
	t.Cleanup(server.Close)
	return server.URL
}

func TestEnrollSendsKeyAndHostFacts(t *testing.T) {
	stub := &stubNodeService{}
	url := newStubServer(t, stub)

	pub, priv, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatalf("GenerateKey: %v", err)
	}

	host := inventory.HostInfo{
		Hostname: "mac-studio", Platform: "darwin", Arch: "arm64",
		OSVersion: "15.0", TotalMemoryBytes: 137438953472, CPUCores: 24,
	}

	result, err := Enroll(context.Background(), url, "ABCD-EFGH", "mac-studio", priv, host)
	if err != nil {
		t.Fatalf("Enroll: %v", err)
	}
	if result.NodeID != "node-123" || result.OrgID != "org_abc" {
		t.Fatalf("unexpected result %+v", result)
	}

	got := stub.lastRequest
	if got.PairingCode != "ABCD-EFGH" {
		t.Errorf("pairing code = %q", got.PairingCode)
	}
	if len(got.PublicKey) != ed25519.PublicKeySize {
		t.Fatalf("public key is %d bytes, want %d", len(got.PublicKey), ed25519.PublicKeySize)
	}
	if string(got.PublicKey) != string(pub) {
		t.Error("the enrolled public key does not match the generated private key")
	}
	if got.Host.GetHostname() != "mac-studio" || got.Host.GetCpuCores() != 24 {
		t.Errorf("host facts not forwarded: %+v", got.Host)
	}
}

func TestEnrollSurfacesServerRejection(t *testing.T) {
	stub := &stubNodeService{err: connect.NewError(connect.CodeInvalidArgument, nil)}
	url := newStubServer(t, stub)
	_, priv, _ := ed25519.GenerateKey(rand.Reader)

	if _, err := Enroll(context.Background(), url, "BAD-CODE", "n", priv, inventory.HostInfo{}); err == nil {
		t.Fatal("expected an error when the server rejects the code, got nil")
	}
}
