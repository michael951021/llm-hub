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

// Probe discovers and samples one class of device. Implementations know
// nothing about the network; that separation is what makes the whole connect
// loop testable without hardware.
type Probe interface {
	Name() string
	Discover(ctx context.Context) ([]Device, error)
	Sample(ctx context.Context, d Device) (Sample, error)
}

// Inventory is the result of one discovery pass: the devices found, plus which
// probe owns each one. Discovery happens once per connection; sampling then
// runs every few seconds against this map rather than re-enumerating hardware.
type Inventory struct {
	Devices []Device
	owner   map[string]Probe
}

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

// SampleAll samples every device, tolerating a probe that fails: one GPU that
// has fallen off the bus must not stop the node reporting the others.
func (i *Inventory) SampleAll(ctx context.Context) ([]Sample, error) {
	samples := make([]Sample, 0, len(i.Devices))
	for _, d := range i.Devices {
		p, ok := i.owner[d.LocalID]
		if !ok {
			continue
		}
		s, err := p.Sample(ctx, d)
		if err != nil {
			// Log and drop: one device that has stopped sampling must not
			// stop the node reporting the rest. Deliberately unfiltered and
			// undeduplicated — a broken GPU will be noisy at the sample
			// interval, and that noise is preferable to a device failing
			// silently. Slice 8's observability work replaces this wholesale.
			slog.Warn("inventory: device sample failed", "local_id", d.LocalID, "probe", p.Name(), "err", err)
			continue
		}
		samples = append(samples, s)
	}
	return samples, nil
}

// DefaultProbes returns every probe available in this build, on this machine.
// The CPU probe is always present: a node with no accelerator is still a node.
func DefaultProbes() []Probe {
	probes := []Probe{NewCPUProbe()}
	probes = append(probes, newPlatformProbes()...)
	probes = append(probes, newCUDAProbes()...)
	return probes
}
