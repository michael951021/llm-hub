package config

import (
	"encoding/json"
	"errors"
	"io/fs"
	"os"
	"path/filepath"
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
