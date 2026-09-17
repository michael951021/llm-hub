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

// Session owns one agent's long-lived relationship with the control plane:
// dial, authenticate, report inventory, sample on the server-given interval,
// and reconnect with jittered backoff for as long as the caller's context
// stays alive.
type Session struct {
	ServerURL  string
	NodeID     string
	PrivateKey ed25519.PrivateKey
	Probes     []inventory.Probe
	Logger     *slog.Logger

	MinBackoff time.Duration
	MaxBackoff time.Duration
}

func (s *Session) logger() *slog.Logger {
	if s.Logger != nil {
		return s.Logger
	}
	return slog.Default()
}

// Run connects and keeps reconnecting until ctx is cancelled. It only
// returns an error for conditions that will never resolve on their own; a
// cancelled ctx always yields a nil return, from whichever state Run was in
// — waiting on backoff, blocked on the stream, or mid-sample.
func (s *Session) Run(ctx context.Context) error {
	backoff := s.MinBackoff
	if backoff <= 0 {
		backoff = time.Second
	}
	maxBackoff := s.MaxBackoff
	if maxBackoff <= 0 {
		maxBackoff = 30 * time.Second
	}

	for {
		if ctx.Err() != nil {
			return nil
		}

		err := s.connectOnce(ctx)
		if ctx.Err() != nil {
			return nil
		}
		if err != nil {
			s.logger().Warn("connection ended", "error", err, "retry_in", backoff)
		} else {
			s.logger().Info("connection closed by server", "retry_in", backoff)
		}

		// Full jitter: without it, a fleet that loses the control plane all
		// reconnects in lockstep the moment it returns.
		wait := time.Duration(rand.Int63n(int64(backoff) + 1))
		select {
		case <-ctx.Done():
			return nil
		case <-time.After(wait):
		}

		backoff *= 2
		if backoff > maxBackoff {
			backoff = maxBackoff
		}
	}
}

// connectOnce makes one connection attempt: authenticate, hello, learn the
// sample interval, report inventory, then sample on that interval until the
// stream ends or ctx is cancelled.
func (s *Session) connectOnce(ctx context.Context) error {
	streamCtx, cancel := context.WithCancel(ctx)
	defer cancel()

	stream := NewNodeClient(s.ServerURL).Connect(streamCtx)
	// Authenticate fresh on every attempt: the server enforces a skew
	// window and rejects a replayed nonce, so a header built once and
	// reused across reconnects would start failing the moment a reconnect
	// lands outside that window.
	stream.RequestHeader().Set("Authorization", AuthHeader(s.NodeID, s.PrivateKey, time.Now()))

	host, err := inventory.Host(streamCtx)
	if err != nil {
		return err
	}
	if err := stream.Send(&modelhubv1.AgentMessage{
		Payload: &modelhubv1.AgentMessage_Hello{
			Hello: &modelhubv1.Hello{AgentVersion: version.Version, Host: hostProto(host)},
		},
	}); err != nil {
		return err
	}

	// The first server message tells us how often to sample.
	first, err := stream.Receive()
	if err != nil {
		return err
	}
	interval := 5 * time.Second
	if ack := first.GetHelloAck(); ack != nil && ack.GetSampleIntervalMs() > 0 {
		interval = time.Duration(ack.GetSampleIntervalMs()) * time.Millisecond
	}

	// Collect is all-or-nothing on a probe's Discover error (unlike
	// SampleAll, which tolerates a single device's failure), so treat a
	// failure here as a connection-level failure: return it and let Run's
	// backoff retry, rather than crashing or reporting zero devices.
	inv, err := inventory.Collect(streamCtx, s.Probes)
	if err != nil {
		return err
	}
	if err := stream.Send(&modelhubv1.AgentMessage{
		Payload: &modelhubv1.AgentMessage_Inventory{
			Inventory: &modelhubv1.InventoryReport{Devices: devicesProto(inv.Devices)},
		},
	}); err != nil {
		return err
	}

	// Drain server messages on their own goroutine so a mid-stream config
	// update is observed and a server hang-up cancels the sampler promptly
	// instead of waiting for the next tick to notice.
	go func() {
		for {
			msg, err := stream.Receive()
			if err != nil {
				cancel()
				return
			}
			if cfg := msg.GetConfig(); cfg != nil && cfg.GetSampleIntervalMs() > 0 {
				s.logger().Info("server changed the sample interval", "ms", cfg.GetSampleIntervalMs())
			}
		}
	}()

	ticker := time.NewTicker(interval)
	defer ticker.Stop()

	for {
		select {
		case <-streamCtx.Done():
			return stream.CloseRequest()
		case <-ticker.C:
			samples, err := inv.SampleAll(streamCtx)
			if err != nil {
				return err
			}
			if len(samples) == 0 {
				continue
			}
			if err := stream.Send(&modelhubv1.AgentMessage{
				Payload: &modelhubv1.AgentMessage_Samples{
					Samples: &modelhubv1.SampleBatch{Samples: samplesProto(samples)},
				},
			}); err != nil {
				if errors.Is(err, context.Canceled) {
					return nil
				}
				return err
			}
		}
	}
}

func devicesProto(devices []inventory.Device) []*modelhubv1.Device {
	out := make([]*modelhubv1.Device, 0, len(devices))
	for _, d := range devices {
		out = append(out, &modelhubv1.Device{
			LocalId:           d.LocalID,
			Kind:              kindProto(d.Kind),
			Index:             uint32(d.Index),
			Name:              d.Name,
			TotalBytes:        d.TotalBytes,
			WiredLimitBytes:   d.WiredLimitBytes,
			DriverVersion:     d.DriverVersion,
			ComputeCapability: d.ComputeCapability,
		})
	}
	return out
}

func samplesProto(samples []inventory.Sample) []*modelhubv1.DeviceSample {
	out := make([]*modelhubv1.DeviceSample, 0, len(samples))
	for _, sample := range samples {
		out = append(out, &modelhubv1.DeviceSample{
			LocalId:         sample.LocalID,
			UsedBytes:       sample.UsedBytes,
			ManagedBytes:    sample.ManagedBytes,
			Utilization:     sample.Utilization,
			TemperatureC:    sample.TemperatureC,
			PowerWatts:      sample.PowerWatts,
			Pressure:        pressureProto(sample.Pressure),
			SampledAtUnixMs: sample.SampledAt.UnixMilli(),
		})
	}
	return out
}

func kindProto(k inventory.Kind) modelhubv1.DeviceKind {
	switch k {
	case inventory.KindCUDA:
		return modelhubv1.DeviceKind_DEVICE_KIND_CUDA
	case inventory.KindMetal:
		return modelhubv1.DeviceKind_DEVICE_KIND_METAL
	case inventory.KindCPU:
		return modelhubv1.DeviceKind_DEVICE_KIND_CPU
	default:
		return modelhubv1.DeviceKind_DEVICE_KIND_UNSPECIFIED
	}
}

// pressureProto mirrors kindProto: a value this build does not recognise
// maps to UNSPECIFIED, not to a plausible-looking default. inventory.Pressure
// is an open string type, so defaulting to NORMAL would hand a free "the
// machine is fine" to any future probe that forgets to set it — and NORMAL is
// the one value with consequences, since the UI renders "not accepting work —
// under memory pressure" off anything at or above WARN. Unknown has to stay
// representable on the wire for the server to be able to tell the difference.
func pressureProto(p inventory.Pressure) modelhubv1.MemoryPressure {
	switch p {
	case inventory.PressureNormal:
		return modelhubv1.MemoryPressure_MEMORY_PRESSURE_NORMAL
	case inventory.PressureWarn:
		return modelhubv1.MemoryPressure_MEMORY_PRESSURE_WARN
	case inventory.PressureCritical:
		return modelhubv1.MemoryPressure_MEMORY_PRESSURE_CRITICAL
	default:
		return modelhubv1.MemoryPressure_MEMORY_PRESSURE_UNSPECIFIED
	}
}
