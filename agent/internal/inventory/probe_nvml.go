//go:build nvml

package inventory

import (
	"context"
	"fmt"
	"time"

	"github.com/NVIDIA/go-nvml/pkg/nvml"
)

type nvmlProbe struct{ driverVersion string }

func newCUDAProbes() []Probe {
	if ret := nvml.Init(); ret != nvml.SUCCESS {
		// No driver on this machine: not an error, just no CUDA devices.
		return nil
	}
	version, _ := nvml.SystemGetDriverVersion()
	return []Probe{&nvmlProbe{driverVersion: version}}
}

func (n *nvmlProbe) Name() string { return "cuda" }

func (n *nvmlProbe) Discover(context.Context) ([]Device, error) {
	count, ret := nvml.DeviceGetCount()
	if ret != nvml.SUCCESS {
		return nil, fmt.Errorf("nvml device count: %v", nvml.ErrorString(ret))
	}

	devices := make([]Device, 0, count)
	for i := 0; i < count; i++ {
		handle, ret := nvml.DeviceGetHandleByIndex(i)
		if ret != nvml.SUCCESS {
			continue
		}
		name, _ := handle.GetName()
		memory, ret := handle.GetMemoryInfo()
		if ret != nvml.SUCCESS {
			continue
		}
		major, minor, _ := handle.GetCudaComputeCapability()

		devices = append(devices, Device{
			LocalID:           fmt.Sprintf("cuda:%d", i),
			Kind:              KindCUDA,
			Index:             i,
			Name:              name,
			TotalBytes:        memory.Total,
			DriverVersion:     n.driverVersion,
			ComputeCapability: fmt.Sprintf("%d.%d", major, minor),
		})
	}
	return devices, nil
}

func (n *nvmlProbe) Sample(_ context.Context, d Device) (Sample, error) {
	handle, ret := nvml.DeviceGetHandleByIndex(d.Index)
	if ret != nvml.SUCCESS {
		return Sample{}, fmt.Errorf("nvml handle %d: %v", d.Index, nvml.ErrorString(ret))
	}
	memory, ret := handle.GetMemoryInfo()
	if ret != nvml.SUCCESS {
		return Sample{}, fmt.Errorf("nvml memory %d: %v", d.Index, nvml.ErrorString(ret))
	}

	util := 0.0
	if u, ret := handle.GetUtilizationRates(); ret == nvml.SUCCESS {
		util = float64(u.Gpu) / 100
	}
	temp := 0.0
	if t, ret := handle.GetTemperature(nvml.TEMPERATURE_GPU); ret == nvml.SUCCESS {
		temp = float64(t)
	}
	power := 0.0
	if p, ret := handle.GetPowerUsage(); ret == nvml.SUCCESS {
		power = float64(p) / 1000
	}

	return Sample{
		LocalID:      d.LocalID,
		UsedBytes:    memory.Used,
		Utilization:  clamp01(util),
		TemperatureC: temp,
		PowerWatts:   power,
		Pressure:     PressureNormal,
		SampledAt:    time.Now(),
	}, nil
}
