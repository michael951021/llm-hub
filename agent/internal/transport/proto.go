package transport

import (
	modelhubv1 "github.com/modelhub/agent/gen/modelhub/v1"
	"github.com/modelhub/agent/internal/inventory"
	"github.com/modelhub/agent/internal/version"
)

// Conversions from inventory's types to the wire contract.

func hostProto(h inventory.HostInfo) *modelhubv1.HostInfo {
	return &modelhubv1.HostInfo{
		Hostname:         h.Hostname,
		Platform:         h.Platform,
		Arch:             h.Arch,
		OsVersion:        h.OSVersion,
		AgentVersion:     version.Version,
		TotalMemoryBytes: h.TotalMemoryBytes,
		CpuCores:         uint32(h.CPUCores),
	}
}

func devicesProto(devices []inventory.Device) []*modelhubv1.Device {
	out := make([]*modelhubv1.Device, len(devices))
	for i, d := range devices {
		out[i] = &modelhubv1.Device{
			LocalId:           d.LocalID,
			Kind:              kindProto[d.Kind],
			Index:             uint32(d.Index),
			Name:              d.Name,
			TotalBytes:        d.TotalBytes,
			WiredLimitBytes:   d.WiredLimitBytes,
			DriverVersion:     d.DriverVersion,
			ComputeCapability: d.ComputeCapability,
		}
	}
	return out
}

func samplesProto(samples []inventory.Sample) []*modelhubv1.DeviceSample {
	out := make([]*modelhubv1.DeviceSample, len(samples))
	for i, s := range samples {
		out[i] = &modelhubv1.DeviceSample{
			LocalId:         s.LocalID,
			UsedBytes:       s.UsedBytes,
			ManagedBytes:    s.ManagedBytes,
			Utilization:     s.Utilization,
			TemperatureC:    s.TemperatureC,
			PowerWatts:      s.PowerWatts,
			Pressure:        pressureProto[s.Pressure],
			SampledAtUnixMs: s.SampledAt.UnixMilli(),
		}
	}
	return out
}

// Values missing from these maps become UNSPECIFIED (the zero value), never
// a plausible default: the server drops devices of unknown kind rather than
// mislabel them, and a missing pressure must not read as "normal".
var kindProto = map[inventory.Kind]modelhubv1.DeviceKind{
	inventory.KindCPU:   modelhubv1.DeviceKind_DEVICE_KIND_CPU,
	inventory.KindCUDA:  modelhubv1.DeviceKind_DEVICE_KIND_CUDA,
	inventory.KindMetal: modelhubv1.DeviceKind_DEVICE_KIND_METAL,
}

var pressureProto = map[inventory.Pressure]modelhubv1.MemoryPressure{
	inventory.PressureNormal:   modelhubv1.MemoryPressure_MEMORY_PRESSURE_NORMAL,
	inventory.PressureWarn:     modelhubv1.MemoryPressure_MEMORY_PRESSURE_WARN,
	inventory.PressureCritical: modelhubv1.MemoryPressure_MEMORY_PRESSURE_CRITICAL,
}
