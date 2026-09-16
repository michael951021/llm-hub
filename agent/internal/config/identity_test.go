package config

import (
	"bytes"
	"crypto/ed25519"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/zalando/go-keyring"
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

// TestKeyringIdentityWrapsBothErrorsOnDoubleFailure guards against silently
// discarding the keychain error when both the keychain and the fallback
// file fail: a user whose keychain is locked needs to see that, not just a
// confusing file-path error.
func TestKeyringIdentityWrapsBothErrorsOnDoubleFailure(t *testing.T) {
	keyring.MockInitWithError(errors.New("keychain is locked"))
	t.Cleanup(keyring.MockInit)

	// Make the fallback file path un-creatable: a regular file in the way
	// of a directory component makes MkdirAll fail. (Named "obstacle", not
	// anything containing "locked" — that would spoil the assertion below.)
	base := t.TempDir()
	obstacle := filepath.Join(base, "obstacle")
	if err := os.WriteFile(obstacle, []byte("x"), 0o600); err != nil {
		t.Fatalf("setup: %v", err)
	}
	dir := filepath.Join(obstacle, "modelhub")

	_, err := NewIdentity(dir).LoadOrCreate()
	if err == nil {
		t.Fatal("expected an error when both the keyring and the fallback file fail")
	}
	if !strings.Contains(err.Error(), "locked") {
		t.Errorf("error does not mention the keychain failure: %v", err)
	}
}
