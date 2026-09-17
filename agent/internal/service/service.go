// Package service wraps the agent's session loop for the host's system
// service manager (launchd on macOS, systemd et al. on Linux, the Windows
// service manager) via github.com/kardianos/service.
//
// Design note: the installed service does not run through this package's
// runner at all. Install() registers a service whose Arguments are
// []string{"run"} (see config below), so the service manager execs the very
// same binary as `modelhub-agent run` — which already shuts down promptly on
// SIGTERM/SIGINT via the signal.NotifyContext wired up in cmd/agent/main.go
// and transport.Session.Run's prompt return on context cancellation (Task
// 15). The runner type below exists only to satisfy kardianos/service's
// service.Interface so New() can be constructed for Install/Start/Stop/
// Uninstall; its Start/Stop are never exercised by the installed service
// itself, only kept correct (non-blocking Start, Stop that waits for the
// session to unwind) in case anything ever calls Service.Run() directly.
package service

import (
	"context"
	"fmt"

	"github.com/kardianos/service"
)

// runner adapts our session loop to kardianos/service's Start/Stop contract.
type runner struct {
	run    func(ctx context.Context) error
	cancel context.CancelFunc
	done   chan struct{}
}

// Start must return promptly — the service manager expects it to signal
// "started" quickly, not to block for the lifetime of the service. The
// actual work runs on a goroutine.
func (r *runner) Start(service.Service) error {
	ctx, cancel := context.WithCancel(context.Background())
	r.cancel = cancel
	r.done = make(chan struct{})
	go func() {
		defer close(r.done)
		_ = r.run(ctx)
	}()
	return nil
}

// Stop cancels the session's context and waits for it to unwind before
// returning, so the service manager sees a clean stop rather than killing
// the process mid-stream.
func (r *runner) Stop(service.Service) error {
	if r.cancel != nil {
		r.cancel()
	}
	if r.done != nil {
		<-r.done
	}
	return nil
}

func config() *service.Config {
	return &service.Config{
		Name:        "modelhub-agent",
		DisplayName: "Model Hub Agent",
		Description: "Reports this machine's compute to Model Hub and runs assigned workloads.",
		Arguments:   []string{"run"},
	}
}

// New constructs the service wrapper. run is the agent's session loop
// (typically the same function wired to `modelhub-agent run`).
func New(run func(ctx context.Context) error) (service.Service, error) {
	return service.New(&runner{run: run}, config())
}

// Install registers modelhub-agent as a system service and starts it. The
// caller is responsible for confirming the node is enrolled first — a
// service that starts but can never authenticate just fails on a loop.
func Install(run func(ctx context.Context) error) error {
	s, err := New(run)
	if err != nil {
		return err
	}
	if err := s.Install(); err != nil {
		return fmt.Errorf("install failed (try again with sudo): %w", err)
	}
	return s.Start()
}

// Uninstall stops and removes the system service registration. It does not
// touch node identity or config files — see cmd/agent's uninstall command,
// which removes those separately and explicitly.
func Uninstall(run func(ctx context.Context) error) error {
	s, err := New(run)
	if err != nil {
		return err
	}
	_ = s.Stop()
	return s.Uninstall()
}
