// Package config owns this agent's on-disk state: config.json (which server
// and node this is) and the node's Ed25519 identity (identity.go).
package config

import (
	"encoding/json"
	"errors"
	"io/fs"
	"os"
	"path/filepath"
	"runtime"
)

const (
	configFileName   = "config.json"
	identityFileName = "identity.key"
)

type Config struct {
	ServerURL string `json:"server_url"`
	NodeID    string `json:"node_id"`
	OrgID     string `json:"org_id"`
	NodeName  string `json:"node_name"`
}

// Enrolled reports whether this agent has an identity the server knows about.
func (c *Config) Enrolled() bool {
	return c.NodeID != "" && c.ServerURL != ""
}

// Dir returns the directory holding this agent's config and identity:
// $MODELHUB_CONFIG_DIR if set, a machine-wide path when running as root
// (i.e. as a system service), otherwise the user's config directory.
func Dir() string {
	if custom := os.Getenv("MODELHUB_CONFIG_DIR"); custom != "" {
		return custom
	}
	if os.Geteuid() == 0 {
		if runtime.GOOS == "windows" {
			return filepath.Join(os.Getenv("ProgramData"), "ModelHub")
		}
		return "/etc/modelhub"
	}
	base, err := os.UserConfigDir()
	if err != nil {
		return ".modelhub"
	}
	return filepath.Join(base, "modelhub")
}

// Load reads dir's config. A missing file is an empty (unenrolled) config.
func Load(dir string) (*Config, error) {
	data, err := os.ReadFile(filepath.Join(dir, configFileName))
	if errors.Is(err, fs.ErrNotExist) {
		return &Config{}, nil
	}
	if err != nil {
		return nil, err
	}
	var c Config
	if err := json.Unmarshal(data, &c); err != nil {
		return nil, err
	}
	return &c, nil
}

func (c *Config) Save(dir string) error {
	data, err := json.MarshalIndent(c, "", "  ")
	if err != nil {
		return err
	}
	return writeFile(filepath.Join(dir, configFileName), data)
}

// ClearEnrollment blanks the enrollment in dir's config, if there is one.
// It must go together with Identity.Delete: a config that still claims to be
// enrolled with no key behind it can never authenticate.
func ClearEnrollment(dir string) error {
	if _, err := os.Stat(filepath.Join(dir, configFileName)); errors.Is(err, fs.ErrNotExist) {
		return nil
	} else if err != nil {
		return err
	}
	return (&Config{}).Save(dir)
}

// writeFile writes a 0600 file via temp-and-rename, so a crash never leaves
// a truncated config or half-written private key behind.
func writeFile(path string, data []byte) error {
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return err
	}
	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, data, 0o600); err != nil {
		return err
	}
	return os.Rename(tmp, path)
}
