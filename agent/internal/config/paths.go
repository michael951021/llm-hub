package config

import (
	"io/fs"
	"os"
	"path/filepath"
	"runtime"
)

const (
	configFileName   = "config.json"
	identityFileName = "identity.key"
)

// Dir returns the directory holding this agent's configuration and identity.
// A system service writes to a machine-wide path; a developer running the
// binary by hand writes under their own config directory.
func Dir() string {
	if custom := os.Getenv("MODELHUB_CONFIG_DIR"); custom != "" {
		return custom
	}
	if os.Geteuid() == 0 {
		switch runtime.GOOS {
		case "windows":
			return filepath.Join(os.Getenv("ProgramData"), "ModelHub")
		default:
			return "/etc/modelhub"
		}
	}
	base, err := os.UserConfigDir()
	if err != nil {
		return ".modelhub"
	}
	return filepath.Join(base, "modelhub")
}

func writeFile(path string, data []byte) error {
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return err
	}
	// Write to a temp file then rename, so a crash never leaves a truncated
	// config or a half-written private key behind.
	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, data, 0o600); err != nil {
		return err
	}
	return os.Rename(tmp, path)
}

func fileMode(path string) (fs.FileMode, error) {
	info, err := os.Stat(path)
	if err != nil {
		return 0, err
	}
	return info.Mode(), nil
}
