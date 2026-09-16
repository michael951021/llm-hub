package config

import (
	"bytes"
	"crypto/ed25519"
	"path/filepath"
	"testing"
)

func TestFileIdentityGeneratesAndPersists(t *testing.T) {
	dir := t.TempDir()
	id := NewFileIdentity(dir)

	key, err := id.LoadOrCreate()
	if err != nil {
		t.Fatalf("LoadOrCreate: %v", err)
	}
	if len(key) != ed25519.PrivateKeySize {
		t.Fatalf("key size = %d, want %d", len(key), ed25519.PrivateKeySize)
	}

	again, err := NewFileIdentity(dir).LoadOrCreate()
	if err != nil {
		t.Fatalf("second LoadOrCreate: %v", err)
	}
	if !bytes.Equal(key, again) {
		t.Fatal("LoadOrCreate generated a new key instead of loading the stored one")
	}
}

func TestFileIdentityIsNotReadableByOthers(t *testing.T) {
	dir := t.TempDir()
	if _, err := NewFileIdentity(dir).LoadOrCreate(); err != nil {
		t.Fatalf("LoadOrCreate: %v", err)
	}
	mode, err := fileMode(filepath.Join(dir, identityFileName))
	if err != nil {
		t.Fatalf("stat: %v", err)
	}
	if mode.Perm() != 0o600 {
		t.Fatalf("identity permissions = %v, want 0600", mode.Perm())
	}
}

func TestFileIdentityRejectsCorruptKeyMaterial(t *testing.T) {
	dir := t.TempDir()
	if err := writeFile(filepath.Join(dir, identityFileName), []byte("not-a-key")); err != nil {
		t.Fatalf("writeFile: %v", err)
	}
	if _, err := NewFileIdentity(dir).LoadOrCreate(); err == nil {
		t.Fatal("expected an error for corrupt key material, got nil")
	}
}
