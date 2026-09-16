//go:build darwin

package inventory

import (
	"context"
	"os/exec"
	"strconv"
	"strings"
	"time"

	"github.com/shirou/gopsutil/v4/mem"
)

// metalProbe reports Apple unified memory. Slice 1 reads sysctl only; the Metal
// cgo shim for recommendedMaxWorkingSetSize arrives in slice 2, when our own
// allocations first need to be distinguished from everyone else's.
type metalProbe struct{}

func newPlatformProbes() []Probe { return []Probe{&metalProbe{}} }

func (m *metalProbe) Name() string { return "metal" }

func (m *metalProbe) Discover(context.Context) ([]Device, error) {
	vm, err := mem.VirtualMemory()
	if err != nil {
		return nil, err
	}
	name := strings.TrimSpace(sysctlString("machdep.cpu.brand_string"))
	if name == "" {
		name = "Apple Silicon GPU"
	}
	return []Device{{
		LocalID:         "metal:0",
		Kind:            KindMetal,
		Index:           0,
		Name:            name,
		TotalBytes:      vm.Total,
		WiredLimitBytes: wiredLimitBytes(),
	}}, nil
}

func (m *metalProbe) Sample(_ context.Context, d Device) (Sample, error) {
	vm, err := mem.VirtualMemory()
	if err != nil {
		return Sample{}, err
	}
	return Sample{
		LocalID:   d.LocalID,
		UsedBytes: vm.Total - vm.Available,
		Pressure:  memoryPressure(),
		SampledAt: time.Now(),
	}, nil
}

func sysctlString(key string) string {
	out, err := exec.Command("sysctl", "-n", key).Output()
	if err != nil {
		return ""
	}
	return strings.TrimSpace(string(out))
}

// iogpu.wired_limit_mb is 0 or absent unless an administrator has set it.
func wiredLimitBytes() uint64 {
	mb, err := strconv.ParseUint(sysctlString("iogpu.wired_limit_mb"), 10, 64)
	if err != nil || mb == 0 {
		return 0
	}
	return mb * 1024 * 1024
}

// kern.memorystatus_vm_pressure_level: 1 normal, 2 warn, 4 critical.
func memoryPressure() Pressure {
	switch sysctlString("kern.memorystatus_vm_pressure_level") {
	case "2":
		return PressureWarn
	case "4":
		return PressureCritical
	default:
		return PressureNormal
	}
}
