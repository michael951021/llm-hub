package inventory

import (
	"bytes"
	"context"
	"errors"
	"log/slog"
	"strings"
	"testing"
)

// Every probe compiled into this build, real hardware included, must satisfy these.
func TestProbeConformance(t *testing.T) {
	probes := append([]Probe{NewFakeProbe(2)}, DefaultProbes()...)

	for _, p := range probes {
		t.Run(p.Name(), func(t *testing.T) {
			ctx := context.Background()

			devices, err := p.Discover(ctx)
			if err != nil {
				t.Fatalf("Discover: %v", err)
			}

			seen := map[string]bool{}
			for _, d := range devices {
				if d.LocalID == "" {
					t.Error("device has an empty LocalID")
				}
				if seen[d.LocalID] {
					t.Errorf("duplicate LocalID %q within one probe", d.LocalID)
				}
				seen[d.LocalID] = true

				if d.TotalBytes == 0 {
					t.Errorf("%s reports zero total bytes", d.LocalID)
				}
				if d.Kind != KindCPU && d.Kind != KindCUDA && d.Kind != KindMetal {
					t.Errorf("%s has unknown kind %q", d.LocalID, d.Kind)
				}

				s, err := p.Sample(ctx, d)
				if err != nil {
					t.Fatalf("Sample(%s): %v", d.LocalID, err)
				}
				if s.LocalID != d.LocalID {
					t.Errorf("sample LocalID = %q, want %q", s.LocalID, d.LocalID)
				}
				if s.UsedBytes > d.TotalBytes {
					t.Errorf("%s used %d > total %d", d.LocalID, s.UsedBytes, d.TotalBytes)
				}
				if s.Utilization < 0 || s.Utilization > 1 {
					t.Errorf("%s utilization %v outside [0,1]", d.LocalID, s.Utilization)
				}
				if s.SampledAt.IsZero() {
					t.Errorf("%s sample has no timestamp", d.LocalID)
				}
			}
		})
	}
}

func TestCollectKeepsLocalIDsUniqueAcrossProbes(t *testing.T) {
	inv, err := Collect(context.Background(), []Probe{NewFakeProbe(2), NewFakeProbe(2)})
	if err != nil {
		t.Fatalf("Collect: %v", err)
	}
	if len(inv.Devices) != 4 {
		t.Fatalf("expected 4 devices from two probes, got %d", len(inv.Devices))
	}
	seen := map[string]bool{}
	for _, d := range inv.Devices {
		if seen[d.LocalID] {
			t.Fatalf("Collect produced a duplicate LocalID %q across probes", d.LocalID)
		}
		seen[d.LocalID] = true
	}
}

func TestSampleAllReturnsOneSamplePerDevice(t *testing.T) {
	inv, err := Collect(context.Background(), []Probe{NewFakeProbe(3)})
	if err != nil {
		t.Fatalf("Collect: %v", err)
	}
	if n := len(inv.SampleAll(context.Background())); n != 3 {
		t.Fatalf("expected 3 samples, got %d", n)
	}
}

func TestSampleAllLogsAndSkipsAFailingDeviceWithoutLosingTheRest(t *testing.T) {
	var logs bytes.Buffer
	prev := slog.Default()
	slog.SetDefault(slog.New(slog.NewTextHandler(&logs, nil)))
	t.Cleanup(func() { slog.SetDefault(prev) })

	bad := NewFakeProbe(1)
	bad.SampleErr = errors.New("gpu fell off the bus")
	inv, err := Collect(context.Background(), []Probe{NewFakeProbe(1), bad})
	if err != nil {
		t.Fatalf("Collect: %v", err)
	}

	if n := len(inv.SampleAll(context.Background())); n != 1 {
		t.Fatalf("expected the healthy device to still report, got %d samples", n)
	}
	for _, want := range []string{"WARN", bad.Name() + ":0", "gpu fell off the bus"} {
		if !strings.Contains(logs.String(), want) {
			t.Errorf("log output missing %q; got: %s", want, logs.String())
		}
	}
}

func TestCollectRejectsDuplicateLocalIDs(t *testing.T) {
	p := NewFakeProbe(1)
	if _, err := Collect(context.Background(), []Probe{p, p}); err == nil {
		t.Fatal("expected an error when two probes report the same LocalID")
	}
}

func TestHostReportsUsableFacts(t *testing.T) {
	h, err := Host(context.Background())
	if err != nil {
		t.Fatalf("Host: %v", err)
	}
	if h.Hostname == "" {
		t.Error("hostname is empty")
	}
	if h.TotalMemoryBytes == 0 {
		t.Error("total memory is zero")
	}
	if h.CPUCores == 0 {
		t.Error("cpu cores is zero")
	}
	if h.Platform == "" || h.Arch == "" {
		t.Error("platform or arch is empty")
	}
}
