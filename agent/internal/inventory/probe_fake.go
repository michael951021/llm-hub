package inventory

import (
	"context"
	"fmt"
	"sync/atomic"
	"time"
)

var fakeProbeSeq atomic.Int64

// FakeProbe stands in for hardware in tests and in `--fake-probe` mode, which
// is how the end-to-end test runs a real agent in CI with no GPU present.
type FakeProbe struct {
	id        int64
	count     int
	Used      uint64
	Press     Pressure
	DevKind   Kind
	SampleErr error // set in tests to simulate a probe that has stopped working
}

func NewFakeProbe(count int) *FakeProbe {
	return &FakeProbe{
		id:      fakeProbeSeq.Add(1),
		count:   count,
		Used:    2 << 30,
		Press:   PressureNormal,
		DevKind: KindCUDA,
	}
}

func (f *FakeProbe) Name() string { return fmt.Sprintf("fake-%d", f.id) }

func (f *FakeProbe) Discover(context.Context) ([]Device, error) {
	devices := make([]Device, 0, f.count)
	for i := 0; i < f.count; i++ {
		devices = append(devices, Device{
			LocalID:    fmt.Sprintf("%s:%d", f.Name(), i),
			Kind:       f.DevKind,
			Index:      i,
			Name:       "Fake Accelerator",
			TotalBytes: 24 << 30,
		})
	}
	return devices, nil
}

func (f *FakeProbe) Sample(_ context.Context, d Device) (Sample, error) {
	if f.SampleErr != nil {
		return Sample{}, f.SampleErr
	}
	return Sample{
		LocalID:     d.LocalID,
		UsedBytes:   f.Used,
		Utilization: 0.25,
		Pressure:    f.Press,
		SampledAt:   time.Now(),
	}, nil
}
