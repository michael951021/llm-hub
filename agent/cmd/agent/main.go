package main

import (
	"context"
	"fmt"
	"os"
	"os/signal"
	"syscall"

	"github.com/spf13/cobra"

	"github.com/modelhub/agent/internal/config"
	"github.com/modelhub/agent/internal/inventory"
	svc "github.com/modelhub/agent/internal/service"
	"github.com/modelhub/agent/internal/transport"
	"github.com/modelhub/agent/internal/version"
)

func main() {
	root := &cobra.Command{
		Use:     "modelhub-agent",
		Short:   "Model Hub node agent",
		Version: version.Version,
	}

	root.AddCommand(newStatusCmd())
	root.AddCommand(newEnrollCmd())
	root.AddCommand(newRunCmd())
	root.AddCommand(newInstallCmd())
	root.AddCommand(newUninstallCmd())

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	if err := root.ExecuteContext(ctx); err != nil {
		fmt.Fprintln(os.Stderr, "error:", err)
		os.Exit(1)
	}
}

// newSession loads this node's config and identity and builds the session
// it uses to talk to the control plane. It is shared by `run` (interactive
// use) and by the service wrapper that `install` registers (Task 19) —
// both need exactly the same enrollment check and identity load.
func newSession(context.Context) (*transport.Session, error) {
	dir := config.Dir()
	cfg, err := config.Load(dir)
	if err != nil {
		return nil, err
	}
	if !cfg.Enrolled() {
		return nil, fmt.Errorf("this node is not enrolled; run: modelhub-agent enroll --code XXXX-XXXX --server <url>")
	}
	priv, err := config.NewIdentity(dir).LoadOrCreate()
	if err != nil {
		return nil, err
	}
	return &transport.Session{
		ServerURL:  cfg.ServerURL,
		NodeID:     cfg.NodeID,
		PrivateKey: priv,
		Probes:     inventory.DefaultProbes(),
	}, nil
}

// runSession is the function handed to the service wrapper: it is what the
// installed service actually executes (via `modelhub-agent run`, per
// internal/service's Config.Arguments). It always uses real probes — the
// synthetic --fake-probe path is for interactive/CI use of `run` only.
func runSession(ctx context.Context) error {
	s, err := newSession(ctx)
	if err != nil {
		return err
	}
	return s.Run(ctx)
}

// newStatusCmd reports whether this node has already joined an
// organization, and if so, which one.
func newStatusCmd() *cobra.Command {
	return &cobra.Command{
		Use:   "status",
		Short: "Show this node's enrollment status",
		RunE: func(cmd *cobra.Command, _ []string) error {
			cfg, err := config.Load(config.Dir())
			if err != nil {
				return err
			}
			if !cfg.Enrolled() {
				fmt.Fprintln(cmd.OutOrStdout(), "not enrolled — run: modelhub-agent enroll --code XXXX-XXXX --server <url>")
				return nil
			}
			fmt.Fprintf(cmd.OutOrStdout(), "node %s (%s) enrolled to org %s at %s\n",
				cfg.NodeName, cfg.NodeID, cfg.OrgID, cfg.ServerURL)
			return nil
		},
	}
}

// newEnrollCmd claims this machine's membership in an organization using a
// pairing code read off the web app: it presents this node's public key and
// host facts, then persists the resulting node/org identity locally.
func newEnrollCmd() *cobra.Command {
	var (
		enrollCode   string
		enrollServer string
		enrollName   string
	)
	cmd := &cobra.Command{
		Use:   "enroll",
		Short: "Join this machine to a Model Hub organization",
		RunE: func(cmd *cobra.Command, _ []string) error {
			ctx := cmd.Context()
			dir := config.Dir()

			priv, err := config.NewIdentity(dir).LoadOrCreate()
			if err != nil {
				return fmt.Errorf("could not load this node's identity: %w", err)
			}

			host, err := inventory.Host(ctx)
			if err != nil {
				return fmt.Errorf("could not read host facts: %w", err)
			}
			name := enrollName
			if name == "" {
				name = host.Hostname
			}

			result, err := transport.Enroll(ctx, enrollServer, enrollCode, name, priv, host)
			if err != nil {
				return err
			}

			cfg := &config.Config{
				ServerURL: enrollServer,
				NodeID:    result.NodeID,
				OrgID:     result.OrgID,
				NodeName:  name,
			}
			if err := cfg.Save(dir); err != nil {
				// The server has already accepted this node's public key —
				// getting a fresh pairing code and re-running enroll would
				// now be refused as a duplicate key. A plain "enroll
				// failed" message would send the user down that dead end,
				// so make it explicit that enrollment itself succeeded
				// server-side and only the local write failed; the fix is
				// to resolve the local problem (permissions, disk space,
				// MODELHUB_CONFIG_DIR) and rerun status/enroll, or contact
				// your admin to reset this node's registration.
				return fmt.Errorf(
					"this node was enrolled into %q, but the local config could not be saved: %w — "+
						"do not request a new pairing code; this node's key is already registered with the server",
					result.OrgName, err,
				)
			}

			fmt.Fprintf(cmd.OutOrStdout(), "enrolled %q into %s\n", name, result.OrgName)
			return nil
		},
	}
	cmd.Flags().StringVar(&enrollCode, "code", "", "pairing code from the web app (required)")
	cmd.Flags().StringVar(&enrollServer, "server", "http://localhost:3001",
		"control plane agent URL — the AGENT_PORT listener (NodeService), not the browser PORT listener")
	cmd.Flags().StringVar(&enrollName, "name", "", "name for this node (defaults to the hostname)")
	_ = cmd.MarkFlagRequired("code")
	return cmd
}

// newRunCmd starts the long-lived, authenticated connect loop: it dials the
// control plane, reports this node's inventory, and keeps sampling and
// reconnecting until the process is asked to stop. This is also the
// subcommand the installed system service execs (see internal/service).
func newRunCmd() *cobra.Command {
	var fakeProbe bool
	cmd := &cobra.Command{
		Use:   "run",
		Short: "Run the agent in the foreground",
		RunE: func(cmd *cobra.Command, _ []string) error {
			ctx := cmd.Context()
			session, err := newSession(ctx)
			if err != nil {
				return err
			}
			if fakeProbe {
				// Used by CI, which has no GPU and no Mac. Swapped in after
				// construction so newSession stays the single source of
				// truth for enrollment/identity handling.
				session.Probes = []inventory.Probe{inventory.NewFakeProbe(2)}
			}
			return session.Run(ctx)
		},
	}
	cmd.Flags().BoolVar(&fakeProbe, "fake-probe", false, "report synthetic devices instead of real hardware")
	return cmd
}

// newInstallCmd registers modelhub-agent as a system service (launchd,
// systemd, or the Windows service manager) and starts it. It refuses when
// the node is not enrolled: a service that starts but can never
// authenticate would just fail and restart on a loop, which is worse than
// a clear upfront error telling the operator what to run first.
func newInstallCmd() *cobra.Command {
	return &cobra.Command{
		Use:   "install",
		Short: "Install and start the agent as a system service",
		RunE: func(cmd *cobra.Command, _ []string) error {
			cfg, err := config.Load(config.Dir())
			if err != nil {
				return err
			}
			if !cfg.Enrolled() {
				return fmt.Errorf("this node is not enrolled; run: modelhub-agent enroll --code XXXX-XXXX --server <url> before installing the service")
			}
			if err := svc.Install(runSession); err != nil {
				return err
			}
			fmt.Fprintln(cmd.OutOrStdout(), "installed and started modelhub-agent")
			return nil
		},
	}
}

// newUninstallCmd stops and removes the system service registration and
// deletes this node's stored identity — both the OS keychain entry and any
// file-fallback key — so a subsequent enroll creates a genuinely new
// identity rather than colliding with the one the server already knows
// about. It does not remove the installed binary or the rest of the config
// directory (e.g. config.json); docs/install.md tells the operator to do
// that by hand, and this command's own output says exactly what it did.
func newUninstallCmd() *cobra.Command {
	return &cobra.Command{
		Use:   "uninstall",
		Short: "Stop and remove the agent service, and delete this node's stored identity",
		RunE: func(cmd *cobra.Command, _ []string) error {
			svcErr := svc.Uninstall(runSession)
			idErr := config.NewIdentity(config.Dir()).Delete()
			switch {
			case svcErr != nil && idErr != nil:
				return fmt.Errorf("service removal failed (%v), and identity removal also failed: %w", svcErr, idErr)
			case svcErr != nil:
				return fmt.Errorf("this node's stored identity was deleted, but service removal failed (it may not have been installed): %w", svcErr)
			case idErr != nil:
				return fmt.Errorf("the service was removed, but this node's stored identity could not be deleted: %w", idErr)
			}
			fmt.Fprintln(cmd.OutOrStdout(), "removed modelhub-agent service and deleted this node's stored identity")
			return nil
		},
	}
}
