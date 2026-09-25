// Command modelhub-agent enrolls a machine into a Model Hub organization and
// streams its hardware inventory to the control plane.
package main

import (
	"context"
	"errors"
	"fmt"
	"os"
	"os/signal"
	"syscall"

	"github.com/spf13/cobra"

	"github.com/modelhub/agent/internal/config"
	"github.com/modelhub/agent/internal/inventory"
	"github.com/modelhub/agent/internal/service"
	"github.com/modelhub/agent/internal/transport"
	"github.com/modelhub/agent/internal/version"
)

const enrollHint = "run: modelhub-agent enroll --code XXXX-XXXX --server <url>"

var errNotEnrolled = errors.New("this node is not enrolled; " + enrollHint)

func main() {
	root := &cobra.Command{
		Use: "modelhub-agent", Short: "Model Hub node agent", Version: version.Version,
		// main prints the error itself; a usage dump would bury it.
		SilenceUsage: true, SilenceErrors: true,
	}
	root.AddCommand(statusCmd(), enrollCmd(), runCmd(), installCmd(), uninstallCmd())

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	if err := root.ExecuteContext(ctx); err != nil {
		fmt.Fprintln(os.Stderr, "error:", err)
		os.Exit(1)
	}
}

// loadEnrolled returns this node's config, or errNotEnrolled.
func loadEnrolled() (*config.Config, error) {
	cfg, err := config.Load(config.Dir())
	if err != nil {
		return nil, err
	}
	if !cfg.Enrolled() {
		return nil, errNotEnrolled
	}
	return cfg, nil
}

func statusCmd() *cobra.Command {
	return &cobra.Command{
		Use:   "status",
		Short: "Show this node's enrollment status",
		RunE: func(cmd *cobra.Command, _ []string) error {
			cfg, err := loadEnrolled()
			if errors.Is(err, errNotEnrolled) {
				fmt.Fprintln(cmd.OutOrStdout(), "not enrolled — "+enrollHint)
				return nil
			}
			if err != nil {
				return err
			}
			fmt.Fprintf(cmd.OutOrStdout(), "node %s (%s) enrolled to org %s at %s\n",
				cfg.NodeName, cfg.NodeID, cfg.OrgID, cfg.ServerURL)
			return nil
		},
	}
}

func enrollCmd() *cobra.Command {
	var code, server, name string
	cmd := &cobra.Command{
		Use:   "enroll",
		Short: "Join this machine to a Model Hub organization",
		RunE: func(cmd *cobra.Command, _ []string) error {
			ctx, dir := cmd.Context(), config.Dir()
			priv, err := config.NewIdentity(dir).LoadOrCreate()
			if err != nil {
				return fmt.Errorf("could not load this node's identity: %w", err)
			}
			host, err := inventory.Host(ctx)
			if err != nil {
				return fmt.Errorf("could not read host facts: %w", err)
			}
			if name == "" {
				name = host.Hostname
			}

			result, err := transport.Enroll(ctx, server, code, name, priv, host)
			if err != nil {
				return err
			}
			cfg := &config.Config{ServerURL: server, NodeID: result.NodeID, OrgID: result.OrgID, NodeName: name}
			if err := cfg.Save(dir); err != nil {
				// The server already holds this key, so a fresh code would be
				// refused as a duplicate. Don't send the operator down that path.
				return fmt.Errorf("this node was enrolled into %q, but the local config could not be saved: %w — "+
					"do not request a new pairing code; this node's key is already registered with the server",
					result.OrgName, err)
			}
			fmt.Fprintf(cmd.OutOrStdout(), "enrolled %q into %s\n", name, result.OrgName)
			return nil
		},
	}
	cmd.Flags().StringVar(&code, "code", "", "pairing code from the web app (required)")
	cmd.Flags().StringVar(&server, "server", "http://localhost:3001",
		"control plane agent URL — the AGENT_PORT listener, not the browser PORT")
	cmd.Flags().StringVar(&name, "name", "", "name for this node (defaults to the hostname)")
	_ = cmd.MarkFlagRequired("code")
	return cmd
}

// runCmd is also what the installed system service execs.
func runCmd() *cobra.Command {
	var fakeProbe bool
	cmd := &cobra.Command{
		Use:   "run",
		Short: "Run the agent in the foreground",
		RunE: func(cmd *cobra.Command, _ []string) error {
			cfg, err := loadEnrolled()
			if err != nil {
				return err
			}
			// Load, never LoadOrCreate: a freshly minted key would dial with the
			// old node id and fail authentication forever.
			priv, err := config.NewIdentity(config.Dir()).Load()
			if errors.Is(err, config.ErrNoIdentity) {
				return fmt.Errorf("this node is enrolled as %s, but its identity is missing; re-enroll with: "+
					"modelhub-agent enroll --code XXXX-XXXX --server %s", cfg.NodeID, cfg.ServerURL)
			}
			if err != nil {
				return fmt.Errorf("could not load this node's identity: %w", err)
			}

			probes := inventory.DefaultProbes()
			if fakeProbe {
				probes = []inventory.Probe{inventory.NewFakeProbe(2)}
			}
			session := &transport.Session{ServerURL: cfg.ServerURL, NodeID: cfg.NodeID, PrivateKey: priv, Probes: probes}
			return session.Run(cmd.Context())
		},
	}
	cmd.Flags().BoolVar(&fakeProbe, "fake-probe", false, "report synthetic devices instead of real hardware (for CI)")
	return cmd
}

func installCmd() *cobra.Command {
	return &cobra.Command{
		Use:   "install",
		Short: "Install and start the agent as a system service",
		RunE: func(cmd *cobra.Command, _ []string) error {
			if _, err := loadEnrolled(); err != nil {
				return err
			}
			if err := service.Install(); err != nil {
				return err
			}
			fmt.Fprintln(cmd.OutOrStdout(), "installed and started modelhub-agent")
			return nil
		},
	}
}

// uninstallCmd removes the service, the identity, and the enrollment
// together: an enrollment with no key behind it can never authenticate.
// The binary and config directory stay; docs/install.md covers those.
func uninstallCmd() *cobra.Command {
	return &cobra.Command{
		Use:   "uninstall",
		Short: "Remove the agent service and this node's identity and enrollment",
		RunE: func(cmd *cobra.Command, _ []string) error {
			svcErr := service.Uninstall()
			idErr := config.NewIdentity(config.Dir()).Delete()
			if idErr == nil {
				idErr = config.ClearEnrollment(config.Dir())
			}
			switch {
			case svcErr != nil && idErr != nil:
				return fmt.Errorf("service removal failed (%v), and identity removal also failed: %w", svcErr, idErr)
			case svcErr != nil:
				return fmt.Errorf("identity and enrollment removed, but service removal failed (it may not have been installed): %w", svcErr)
			case idErr != nil:
				return fmt.Errorf("service removed, but this node's identity could not be fully removed: %w", idErr)
			}
			fmt.Fprintln(cmd.OutOrStdout(), "removed modelhub-agent service, deleted this node's identity, and cleared its enrollment")
			return nil
		},
	}
}
