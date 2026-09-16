package inventory

import (
	"context"
	"os"
	"runtime"

	"github.com/shirou/gopsutil/v4/host"
	"github.com/shirou/gopsutil/v4/mem"
)

func Host(ctx context.Context) (HostInfo, error) {
	vm, err := mem.VirtualMemory()
	if err != nil {
		return HostInfo{}, err
	}

	hostname, _ := os.Hostname()
	osVersion := ""
	if info, err := host.InfoWithContext(ctx); err == nil {
		if hostname == "" {
			hostname = info.Hostname
		}
		osVersion = info.PlatformVersion
	}

	return HostInfo{
		Hostname:         hostname,
		Platform:         runtime.GOOS,
		Arch:             runtime.GOARCH,
		OSVersion:        osVersion,
		TotalMemoryBytes: vm.Total,
		CPUCores:         runtime.NumCPU(),
	}, nil
}
