package inventory

import (
	"context"
	"fmt"
	"sync/atomic"
	"time"
)

var fakeProbeSeq atomic.Int64

// FakeProbe reports synthetic CUDA devices. Used by tests and by
// `run --fake-probe`, which is how CI runs a real agent with no GPU.
type FakeProbe struct {
	id        int64
	count     int
	SampleErr error // set to simulate a device that has stopped responding
}

// NewFakeProbe returns a probe with count devices. Each probe gets a unique
// name, so several can be collected together without LocalID collisions.
func NewFakeProbe(count int) *FakeProbe {
	return &FakeProbe{id: fakeProbeSeq.Add(1), count: count}
}

func (f *FakeProbe) Name() string { return fmt.Sprintf("fake-%d", f.id) }

func (f *FakeProbe) Discover(context.Context) ([]Device, error) {
	devices := make([]Device, f.count)
	for i := range devices {
		devices[i] = Device{
			LocalID:    fmt.Sprintf("%s:%d", f.Name(), i),
			Kind:       KindCUDA,
			Index:      i,
			Name:       "Fake Accelerator",
			TotalBytes: 24 << 30,
		}
	}
	return devices, nil
}

func (f *FakeProbe) Sample(_ context.Context, d Device) (Sample, error) {
	if f.SampleErr != nil {
		return Sample{}, f.SampleErr
	}
	return Sample{
		LocalID:     d.LocalID,
		UsedBytes:   2 << 30,
		Utilization: 0.25,
		Pressure:    PressureNormal,
		SampledAt:   time.Now(),
	}, nil
}
