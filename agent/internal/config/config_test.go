package config

import (
	"path/filepath"
	"testing"
)

func TestConfigRoundTrip(t *testing.T) {
	dir := t.TempDir()

	want := &Config{
		ServerURL: "https://hub.example.com",
		NodeID:    "3f9b1e2a-0000-4000-8000-000000000000",
		OrgID:     "org_abc123",
		NodeName:  "mac-studio",
	}
	if err := want.Save(dir); err != nil {
		t.Fatalf("Save: %v", err)
	}

	got, err := Load(dir)
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	if *got != *want {
		t.Fatalf("round trip mismatch:\n got %+v\nwant %+v", got, want)
	}
}

func TestLoadMissingFileReturnsEmptyConfig(t *testing.T) {
	got, err := Load(filepath.Join(t.TempDir(), "absent"))
	if err != nil {
		t.Fatalf("Load on missing dir should not error, got %v", err)
	}
	if got.NodeID != "" {
		t.Fatalf("expected an empty config, got %+v", got)
	}
}

func TestSaveRefusesWorldReadablePermissions(t *testing.T) {
	dir := t.TempDir()
	c := &Config{ServerURL: "https://hub.example.com"}
	if err := c.Save(dir); err != nil {
		t.Fatalf("Save: %v", err)
	}
	mode, err := fileMode(filepath.Join(dir, configFileName))
	if err != nil {
		t.Fatalf("stat: %v", err)
	}
	if mode.Perm() != 0o600 {
		t.Fatalf("config permissions = %v, want 0600", mode.Perm())
	}
}
