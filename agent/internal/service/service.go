// Package service registers the agent with the host's service manager
// (launchd, systemd, the Windows service manager) via kardianos/service.
//
// The registered service simply execs `modelhub-agent run`, which already
// shuts down cleanly on SIGTERM. This package never runs the agent loop
// itself, so the service.Interface it hands kardianos is a no-op.
package service

import (
	"fmt"

	"github.com/kardianos/service"
)

type noop struct{}

func (noop) Start(service.Service) error { return nil }
func (noop) Stop(service.Service) error  { return nil }

func newService() (service.Service, error) {
	return service.New(noop{}, &service.Config{
		Name:        "modelhub-agent",
		DisplayName: "Model Hub Agent",
		Description: "Reports this machine's compute to Model Hub and runs assigned workloads.",
		Arguments:   []string{"run"},
	})
}

// Install registers the service and starts it. Callers must check that the
// node is enrolled first: a service that can't authenticate just crash-loops.
func Install() error {
	s, err := newService()
	if err != nil {
		return err
	}
	if err := s.Install(); err != nil {
		return fmt.Errorf("install failed (try again with sudo): %w", err)
	}
	return s.Start()
}

// Uninstall stops and removes the service. It leaves identity and config alone.
func Uninstall() error {
	s, err := newService()
	if err != nil {
		return err
	}
	_ = s.Stop()
	return s.Uninstall()
}
