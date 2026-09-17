package config

import (
	"errors"
	"io/fs"
	"os"
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

// TestClearEnrollmentMakesTheNodeUnenrolled covers the other half of the
// uninstall fix: deleting the identity while config.json still claimed to be
// enrolled made `install` sail past its not-enrolled guard and register a
// service that could never authenticate.
func TestClearEnrollmentMakesTheNodeUnenrolled(t *testing.T) {
	dir := t.TempDir()
	enrolled := &Config{
		ServerURL: "https://hub.example.com",
		NodeID:    "3f9b1e2a-0000-4000-8000-000000000000",
		OrgID:     "org_abc123",
		NodeName:  "mac-studio",
	}
	if err := enrolled.Save(dir); err != nil {
		t.Fatalf("Save: %v", err)
	}

	if err := ClearEnrollment(dir); err != nil {
		t.Fatalf("ClearEnrollment: %v", err)
	}

	got, err := Load(dir)
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	if got.Enrolled() {
		t.Fatalf("expected the node to be unenrolled after ClearEnrollment, got %+v", got)
	}
}

func TestClearEnrollmentWithoutAConfigIsNotAnError(t *testing.T) {
	dir := t.TempDir()
	if err := ClearEnrollment(dir); err != nil {
		t.Fatalf("ClearEnrollment on a node with no config: %v", err)
	}
	if _, err := os.Stat(filepath.Join(dir, configFileName)); !errors.Is(err, fs.ErrNotExist) {
		t.Fatalf("ClearEnrollment created a config file; stat err = %v", err)
	}
}
