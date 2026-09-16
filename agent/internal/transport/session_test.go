package transport

import (
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"net/http"
	"net/http/httptest"
	"sync"
	"testing"
	"time"

	"connectrpc.com/connect"
	"golang.org/x/net/http2"
	"golang.org/x/net/http2/h2c"

	modelhubv1 "github.com/modelhub/agent/gen/modelhub/v1"
	"github.com/modelhub/agent/gen/modelhub/v1/modelhubv1connect"
	"github.com/modelhub/agent/internal/inventory"
)

type recordingNodeService struct {
	modelhubv1connect.UnimplementedNodeServiceHandler

	mu          sync.Mutex
	connects    int
	hellos      int
	inventories int
	samples     int
	authHeaders []string
	dropAfter   int // close the stream after this many connections, to test reconnect
}

func (r *recordingNodeService) snapshot() (connects, hellos, inventories, samples int) {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.connects, r.hellos, r.inventories, r.samples
}

func (r *recordingNodeService) Connect(
	ctx context.Context,
	stream *connect.BidiStream[modelhubv1.AgentMessage, modelhubv1.ServerMessage],
) error {
	r.mu.Lock()
	r.connects++
	current := r.connects
	r.authHeaders = append(r.authHeaders, stream.RequestHeader().Get("Authorization"))
	r.mu.Unlock()

	if err := stream.Send(&modelhubv1.ServerMessage{
		Payload: &modelhubv1.ServerMessage_HelloAck{
			HelloAck: &modelhubv1.HelloAck{NodeId: "node-abc", SampleIntervalMs: 50},
		},
	}); err != nil {
		return err
	}

	for {
		msg, err := stream.Receive()
		if err != nil {
			return nil
		}
		r.mu.Lock()
		switch msg.GetPayload().(type) {
		case *modelhubv1.AgentMessage_Hello:
			r.hellos++
		case *modelhubv1.AgentMessage_Inventory:
			r.inventories++
		case *modelhubv1.AgentMessage_Samples:
			r.samples++
		}
		shouldDrop := r.dropAfter > 0 && current <= r.dropAfter && r.samples >= current
		r.mu.Unlock()

		if shouldDrop {
			return nil // hang up; the agent must reconnect
		}
	}
}

func newSession(t *testing.T, svc *recordingNodeService) (*Session, func()) {
	t.Helper()
	mux := http.NewServeMux()
	mux.Handle(modelhubv1connect.NewNodeServiceHandler(svc))
	server := httptest.NewServer(h2c.NewHandler(mux, &http2.Server{}))

	_, priv, _ := ed25519.GenerateKey(rand.Reader)
	s := &Session{
		ServerURL:  server.URL,
		NodeID:     "node-abc",
		PrivateKey: priv,
		Probes:     []inventory.Probe{inventory.NewFakeProbe(2)},
		MinBackoff: 10 * time.Millisecond,
		MaxBackoff: 50 * time.Millisecond,
	}
	return s, server.Close
}

func TestSessionReportsInventoryThenSamples(t *testing.T) {
	svc := &recordingNodeService{}
	session, closeServer := newSession(t, svc)
	defer closeServer()

	ctx, cancel := context.WithTimeout(context.Background(), 700*time.Millisecond)
	defer cancel()
	_ = session.Run(ctx)

	connects, hellos, inventories, samples := svc.snapshot()
	if connects == 0 {
		t.Fatal("agent never connected")
	}
	if hellos == 0 {
		t.Error("agent never sent hello")
	}
	if inventories == 0 {
		t.Error("agent never reported inventory")
	}
	if samples < 2 {
		t.Errorf("expected repeated samples on the 50ms interval, got %d", samples)
	}

	svc.mu.Lock()
	header := svc.authHeaders[0]
	svc.mu.Unlock()
	if header == "" {
		t.Error("agent connected without an authorization header")
	}
}

func TestSessionReconnectsAfterTheServerHangsUp(t *testing.T) {
	svc := &recordingNodeService{dropAfter: 2}
	session, closeServer := newSession(t, svc)
	defer closeServer()

	ctx, cancel := context.WithTimeout(context.Background(), 900*time.Millisecond)
	defer cancel()
	_ = session.Run(ctx)

	connects, _, _, _ := svc.snapshot()
	if connects < 2 {
		t.Fatalf("expected the agent to reconnect, saw %d connections", connects)
	}
}

func TestSessionStopsWhenTheContextIsCancelled(t *testing.T) {
	svc := &recordingNodeService{}
	session, closeServer := newSession(t, svc)
	defer closeServer()

	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() { done <- session.Run(ctx) }()

	time.Sleep(150 * time.Millisecond)
	cancel()

	select {
	case <-done:
	case <-time.After(2 * time.Second):
		t.Fatal("Run did not return within 2s of cancellation")
	}
}
