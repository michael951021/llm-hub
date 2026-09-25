package transport

import (
	"crypto/ed25519"
	"crypto/rand"
	"encoding/base64"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"testing"
	"time"

	"golang.org/x/net/http2"
	"golang.org/x/net/http2/h2c"

	modelhubv1 "github.com/modelhub/agent/gen/modelhub/v1"
	"github.com/modelhub/agent/gen/modelhub/v1/modelhubv1connect"
	"github.com/modelhub/agent/internal/inventory"
)

// newStubServer serves handler over h2c, which is what the client speaks to
// an http:// URL; a plain HTTP/1.1 httptest server would refuse it.
func newStubServer(t *testing.T, handler modelhubv1connect.NodeServiceHandler) string {
	t.Helper()
	mux := http.NewServeMux()
	mux.Handle(modelhubv1connect.NewNodeServiceHandler(handler))
	server := httptest.NewServer(h2c.NewHandler(mux, &http2.Server{}))
	t.Cleanup(server.Close)
	return server.URL
}

func TestAuthHeaderMatchesTheServerFormat(t *testing.T) {
	pub, priv, _ := ed25519.GenerateKey(rand.Reader)
	now := time.UnixMilli(1_700_000_000_000)

	header := AuthHeader("node-abc", priv, now)
	parts := strings.Split(strings.TrimPrefix(header, "ModelHubNode "), ".")
	if !strings.HasPrefix(header, "ModelHubNode ") || len(parts) != 4 {
		t.Fatalf("header is not `ModelHubNode a.b.c.d`: %q", header)
	}
	if parts[0] != "node-abc" || parts[1] != strconv.FormatInt(now.UnixMilli(), 10) {
		t.Errorf("node id / timestamp = %q / %q", parts[0], parts[1])
	}
	signature, err := base64.RawURLEncoding.DecodeString(parts[3])
	if err != nil {
		t.Fatalf("signature is not unpadded base64url: %v", err)
	}
	if !ed25519.Verify(pub, []byte(strings.Join(parts[:3], ".")), signature) {
		t.Fatal("signature does not verify against the first three fields")
	}
}

func TestAuthHeaderUsesAFreshNonceEveryTime(t *testing.T) {
	_, priv, _ := ed25519.GenerateKey(rand.Reader)
	now := time.Now()
	if AuthHeader("n", priv, now) == AuthHeader("n", priv, now) {
		t.Fatal("two headers at the same instant were identical; the nonce is not fresh")
	}
}

// The server drops devices of unknown kind and must be able to tell an
// unknown pressure from "normal", so neither may get a plausible default.
func TestUnknownEnumsGoOnTheWireAsUnspecified(t *testing.T) {
	devices := devicesProto([]inventory.Device{{LocalID: "npu:0", Kind: "npu"}})
	if devices[0].Kind != modelhubv1.DeviceKind_DEVICE_KIND_UNSPECIFIED {
		t.Errorf("unknown kind = %v, want UNSPECIFIED", devices[0].Kind)
	}
	samples := samplesProto([]inventory.Sample{{LocalID: "npu:0"}})
	if samples[0].Pressure != modelhubv1.MemoryPressure_MEMORY_PRESSURE_UNSPECIFIED {
		t.Errorf("unset pressure = %v, want UNSPECIFIED", samples[0].Pressure)
	}
}
