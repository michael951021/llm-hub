package config

import (
	"os"
	"path/filepath"
	"testing"
)

var enrolled = Config{
	ServerURL: "https://hub.example.com",
	NodeID:    "3f9b1e2a-0000-4000-8000-000000000000",
	OrgID:     "org_abc123",
	NodeName:  "mac-studio",
}

func TestConfigRoundTripsThroughAPrivateFile(t *testing.T) {
	dir := t.TempDir()
	want := enrolled
	if err := want.Save(dir); err != nil {
		t.Fatalf("Save: %v", err)
	}
	got, err := Load(dir)
	if err != nil || *got != want {
		t.Fatalf("round trip: got %+v, err %v; want %+v", got, err, want)
	}
	info, err := os.Stat(filepath.Join(dir, configFileName))
	if err != nil || info.Mode().Perm() != 0o600 {
		t.Fatalf("config permissions = %v (err %v), want 0600", info.Mode().Perm(), err)
	}
}

func TestLoadWithoutAConfigIsUnenrolled(t *testing.T) {
	got, err := Load(filepath.Join(t.TempDir(), "absent"))
	if err != nil || got.Enrolled() {
		t.Fatalf("expected an empty config, got %+v, err %v", got, err)
	}
}

func TestClearEnrollment(t *testing.T) {
	dir := t.TempDir()
	if err := ClearEnrollment(dir); err != nil {
		t.Fatalf("ClearEnrollment with no config: %v", err)
	}
	assertNoFile(t, filepath.Join(dir, configFileName))

	c := enrolled
	if err := c.Save(dir); err != nil {
		t.Fatal(err)
	}
	if err := ClearEnrollment(dir); err != nil {
		t.Fatalf("ClearEnrollment: %v", err)
	}
	if got, _ := Load(dir); got.Enrolled() {
		t.Fatalf("still enrolled after ClearEnrollment: %+v", got)
	}
}
