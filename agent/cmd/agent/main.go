package main

import (
	"fmt"
	"os"

	"github.com/spf13/cobra"

	"github.com/modelhub/agent/internal/config"
	"github.com/modelhub/agent/internal/version"
)

func main() {
	root := &cobra.Command{
		Use:     "modelhub-agent",
		Short:   "Model Hub node agent",
		Version: version.Version,
	}

	root.AddCommand(&cobra.Command{
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
	})

	if err := root.Execute(); err != nil {
		fmt.Fprintln(os.Stderr, "error:", err)
		os.Exit(1)
	}
}
