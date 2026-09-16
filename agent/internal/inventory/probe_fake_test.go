package inventory

import (
	"context"
	"errors"
	"testing"
)

func TestNewFakeProbeAssignsUniqueNames(t *testing.T) {
	a := NewFakeProbe(1)
	b := NewFakeProbe(1)
	if a.Name() == b.Name() {
		t.Fatalf("two FakeProbes got the same name %q; LocalIDs would collide in Collect", a.Name())
	}
}

func TestFakeProbeDiscoverReturnsRequestedCount(t *testing.T) {
	p := NewFakeProbe(3)
	devices, err := p.Discover(context.Background())
	if err != nil {
		t.Fatalf("Discover: %v", err)
	}
	if len(devices) != 3 {
		t.Fatalf("expected 3 devices, got %d", len(devices))
	}
	for i, d := range devices {
		if d.Index != i {
			t.Errorf("device %d has Index %d, want %d", i, d.Index, i)
		}
	}
}

func TestFakeProbeSampleReturnsSampleErrDirectly(t *testing.T) {
	p := NewFakeProbe(1)
	devices, err := p.Discover(context.Background())
	if err != nil {
		t.Fatalf("Discover: %v", err)
	}

	// Healthy path first.
	if _, err := p.Sample(context.Background(), devices[0]); err != nil {
		t.Fatalf("Sample before SampleErr is set: %v", err)
	}

	// Now simulate the device falling off the bus.
	wantErr := errors.New("gpu fell off the bus")
	p.SampleErr = wantErr
	if _, err := p.Sample(context.Background(), devices[0]); err != wantErr {
		t.Fatalf("Sample() error = %v, want %v", err, wantErr)
	}
}
