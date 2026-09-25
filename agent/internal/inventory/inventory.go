// Package inventory discovers and samples this machine's compute devices.
// Probes (one per device class, selected by build tags) know nothing about
// the network, which is what makes the connect loop testable without hardware.
package inventory

import (
	"context"
	"fmt"
	"log/slog"
	"time"
)

type Kind string

const (
	KindCPU   Kind = "cpu"
	KindCUDA  Kind = "cuda"
	KindMetal Kind = "metal"
)

type Pressure string

const (
	PressureNormal   Pressure = "normal"
	PressureWarn     Pressure = "warn"
	PressureCritical Pressure = "critical"
)

// Device holds facts that do not change while the machine is running.
//
// Never sum TotalBytes to get node capacity: on Apple silicon the cpu and
// metal devices both report the same unified memory, and each is budgeted
// independently against it. Use HostInfo.TotalMemoryBytes instead.
type Device struct {
	LocalID           string
	Kind              Kind
	Index             int
	Name              string
	TotalBytes        uint64
	WiredLimitBytes   uint64 // macOS only
	DriverVersion     string
	ComputeCapability string
}

// Sample holds facts that change constantly.
type Sample struct {
	LocalID      string
	UsedBytes    uint64 // ours plus everyone else's
	ManagedBytes uint64 // ours; always 0 until slice 2 loads a model
	Utilization  float64
	TemperatureC float64
	PowerWatts   float64
	Pressure     Pressure
	SampledAt    time.Time
}

type HostInfo struct {
	Hostname         string
	Platform         string
	Arch             string
	OSVersion        string
	TotalMemoryBytes uint64
	CPUCores         int
}

// Probe discovers and samples one class of device.
type Probe interface {
	Name() string
	Discover(ctx context.Context) ([]Device, error)
	Sample(ctx context.Context, d Device) (Sample, error)
}

// Inventory is one discovery pass: the devices found and the probe that owns
// each. Discovery runs once per connection; sampling reuses it.
type Inventory struct {
	Devices []Device
	owner   map[string]Probe
}

// Collect fails if any probe fails to discover, or two report the same LocalID.
func Collect(ctx context.Context, probes []Probe) (*Inventory, error) {
	inv := &Inventory{owner: map[string]Probe{}}
	for _, p := range probes {
		devices, err := p.Discover(ctx)
		if err != nil {
			return nil, fmt.Errorf("probe %s: %w", p.Name(), err)
		}
		for _, d := range devices {
			if _, dup := inv.owner[d.LocalID]; dup {
				return nil, fmt.Errorf("probe %s produced duplicate device id %q", p.Name(), d.LocalID)
			}
			inv.owner[d.LocalID] = p
			inv.Devices = append(inv.Devices, d)
		}
	}
	return inv, nil
}

// SampleAll samples every device. A device that fails to sample is logged and
// skipped: one GPU that has fallen off the bus must not silence the others.
func (i *Inventory) SampleAll(ctx context.Context) []Sample {
	samples := make([]Sample, 0, len(i.Devices))
	for _, d := range i.Devices {
		p := i.owner[d.LocalID]
		s, err := p.Sample(ctx, d)
		if err != nil {
			slog.Warn("inventory: device sample failed", "local_id", d.LocalID, "probe", p.Name(), "err", err)
			continue
		}
		samples = append(samples, s)
	}
	return samples
}

// DefaultProbes returns every probe available in this build, on this machine.
// The CPU probe is always present: a node with no accelerator is still a node.
func DefaultProbes() []Probe {
	probes := []Probe{NewCPUProbe()}
	probes = append(probes, newPlatformProbes()...)
	probes = append(probes, newCUDAProbes()...)
	return probes
}
