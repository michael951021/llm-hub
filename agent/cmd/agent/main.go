package main

import (
	"context"
	"fmt"
	"os"

	"github.com/spf13/cobra"

	"github.com/modelhub/agent/internal/config"
	"github.com/modelhub/agent/internal/inventory"
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

	if err := root.ExecuteContext(context.Background()); err != nil {
		fmt.Fprintln(os.Stderr, "error:", err)
		os.Exit(1)
	}
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
