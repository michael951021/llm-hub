package transport

import (
	"context"
	"crypto/ed25519"
	"errors"
	"log/slog"
	"math/rand"
	"time"

	modelhubv1 "github.com/modelhub/agent/gen/modelhub/v1"
	"github.com/modelhub/agent/internal/inventory"
	"github.com/modelhub/agent/internal/version"
)

// Session is one agent's long-lived relationship with the control plane:
// dial, authenticate, report inventory, sample on the server-given interval,
// and reconnect with jittered exponential backoff until ctx is cancelled.
type Session struct {
	ServerURL  string
	NodeID     string
	PrivateKey ed25519.PrivateKey
	Probes     []inventory.Probe

	MinBackoff time.Duration // default 1s
	MaxBackoff time.Duration // default 30s
}

// Run connects and keeps reconnecting until ctx is cancelled, then returns
// nil from whatever state it was in.
func (s *Session) Run(ctx context.Context) error {
	backoff, maxBackoff := s.MinBackoff, s.MaxBackoff
	if backoff <= 0 {
		backoff = time.Second
	}
	if maxBackoff <= 0 {
		maxBackoff = 30 * time.Second
	}

	for {
		err := s.connectOnce(ctx)
		if ctx.Err() != nil {
			return nil
		}
		if err != nil {
			slog.Warn("connection ended", "error", err, "retry_in", backoff)
		} else {
			slog.Info("connection closed by server", "retry_in", backoff)
		}

		// Full jitter, so a fleet doesn't reconnect in lockstep when the
		// control plane comes back.
		select {
		case <-ctx.Done():
			return nil
		case <-time.After(time.Duration(rand.Int63n(int64(backoff) + 1))):
		}
		backoff = min(backoff*2, maxBackoff)
	}
}

// connectOnce is one connection: Hello, learn the sample interval from the
// HelloAck, report inventory, then send samples until the stream ends.
func (s *Session) connectOnce(ctx context.Context) error {
	ctx, cancel := context.WithCancel(ctx)
	defer cancel()

	stream := NewNodeClient(s.ServerURL).Connect(ctx)
	stream.RequestHeader().Set("Authorization", AuthHeader(s.NodeID, s.PrivateKey, time.Now()))

	host, err := inventory.Host(ctx)
	if err != nil {
		return err
	}
	if err := stream.Send(&modelhubv1.AgentMessage{Payload: &modelhubv1.AgentMessage_Hello{
		Hello: &modelhubv1.Hello{AgentVersion: version.Version, Host: hostProto(host)},
	}}); err != nil {
		return err
	}

	first, err := stream.Receive()
	if err != nil {
		return err
	}
	interval := 5 * time.Second
	if ms := first.GetHelloAck().GetSampleIntervalMs(); ms > 0 {
		interval = time.Duration(ms) * time.Millisecond
	}

	// A probe that can't discover fails the whole connection; Run retries.
	inv, err := inventory.Collect(ctx, s.Probes)
	if err != nil {
		return err
	}
	if err := stream.Send(&modelhubv1.AgentMessage{Payload: &modelhubv1.AgentMessage_Inventory{
		Inventory: &modelhubv1.InventoryReport{Devices: devicesProto(inv.Devices)},
	}}); err != nil {
		return err
	}

	// Read server messages concurrently, so a hang-up stops the sampler
	// immediately rather than at the next tick.
	go func() {
		defer cancel()
		for {
			msg, err := stream.Receive()
			if err != nil {
				return
			}
			if ms := msg.GetConfig().GetSampleIntervalMs(); ms > 0 {
				slog.Info("server changed the sample interval", "ms", ms)
			}
		}
	}()

	ticker := time.NewTicker(interval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return stream.CloseRequest()
		case <-ticker.C:
			samples := inv.SampleAll(ctx)
			if len(samples) == 0 {
				continue
			}
			err := stream.Send(&modelhubv1.AgentMessage{Payload: &modelhubv1.AgentMessage_Samples{
				Samples: &modelhubv1.SampleBatch{Samples: samplesProto(samples)},
			}})
			if errors.Is(err, context.Canceled) {
				return nil
			}
			if err != nil {
				return err
			}
		}
	}
}
