package inventory

import (
	"context"
	"runtime"
	"time"

	"github.com/shirou/gopsutil/v4/cpu"
	"github.com/shirou/gopsutil/v4/mem"
)

type cpuProbe struct{}

func NewCPUProbe() Probe { return &cpuProbe{} }

func (c *cpuProbe) Name() string { return "cpu" }

func (c *cpuProbe) Discover(context.Context) ([]Device, error) {
	vm, err := mem.VirtualMemory()
	if err != nil {
		return nil, err
	}
	name := runtime.GOARCH + " CPU"
	if infos, err := cpu.Info(); err == nil && len(infos) > 0 && infos[0].ModelName != "" {
		name = infos[0].ModelName
	}
	return []Device{{
		LocalID:    "cpu:0",
		Kind:       KindCPU,
		Index:      0,
		Name:       name,
		TotalBytes: vm.Total,
	}}, nil
}

func (c *cpuProbe) Sample(_ context.Context, d Device) (Sample, error) {
	vm, err := mem.VirtualMemory()
	if err != nil {
		return Sample{}, err
	}
	util := 0.0
	if pct, err := cpu.Percent(0, false); err == nil && len(pct) > 0 {
		util = pct[0] / 100
	}
	return Sample{
		LocalID:     d.LocalID,
		UsedBytes:   vm.Total - vm.Available,
		Utilization: clamp01(util),
		Pressure:    PressureNormal,
		SampledAt:   time.Now(),
	}, nil
}

func clamp01(v float64) float64 {
	if v < 0 {
		return 0
	}
	if v > 1 {
		return 1
	}
	return v
}
