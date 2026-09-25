package config

import (
	"bytes"
	"errors"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/zalando/go-keyring"
)

// lockedKeychain makes every keychain call fail the way a locked login
// keyring or a headless box with no secret service does.
func lockedKeychain(t *testing.T) {
	keyring.MockInitWithError(errors.New("keychain is locked"))
	t.Cleanup(keyring.MockInit)
}

func assertNoFile(t *testing.T, path string) {
	t.Helper()
	if _, err := os.Stat(path); !errors.Is(err, fs.ErrNotExist) {
		t.Fatalf("expected no file at %s, stat err = %v", path, err)
	}
}

func TestLoadOrCreateUsesTheKeychainAndLoadReturnsTheSameKey(t *testing.T) {
	keyring.MockInit()
	dir := t.TempDir()

	created, err := NewIdentity(dir).LoadOrCreate()
	if err != nil {
		t.Fatalf("LoadOrCreate: %v", err)
	}
	loaded, err := NewIdentity(dir).Load()
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	if !bytes.Equal(created, loaded) {
		t.Fatal("Load returned a different key than LoadOrCreate stored")
	}
	assertNoFile(t, filepath.Join(dir, identityFileName))
}

func TestLoadOrCreateFallsBackToAPrivateFileWhenTheKeychainIsUnusable(t *testing.T) {
	lockedKeychain(t)
	dir := t.TempDir()

	created, err := NewIdentity(dir).LoadOrCreate()
	if err != nil {
		t.Fatalf("LoadOrCreate: %v", err)
	}
	info, err := os.Stat(filepath.Join(dir, identityFileName))
	if err != nil {
		t.Fatalf("expected a fallback identity file: %v", err)
	}
	if info.Mode().Perm() != 0o600 {
		t.Fatalf("identity permissions = %v, want 0600", info.Mode().Perm())
	}
	for _, get := range []func() ([]byte, error){
		func() ([]byte, error) { return NewIdentity(dir).LoadOrCreate() },
		func() ([]byte, error) { return NewIdentity(dir).Load() },
	} {
		again, err := get()
		if err != nil || !bytes.Equal(created, again) {
			t.Fatalf("expected the stored fallback key back, got err = %v", err)
		}
	}
}

// A file written while the keychain was down may be this node's real,
// enrolled identity; a working-but-empty keychain must not shadow it.
func TestAnExistingFallbackFileWinsOverMintingANewKey(t *testing.T) {
	lockedKeychain(t)
	dir := t.TempDir()
	original, err := NewIdentity(dir).LoadOrCreate()
	if err != nil {
		t.Fatalf("LoadOrCreate: %v", err)
	}

	keyring.MockInit()
	got, err := NewIdentity(dir).LoadOrCreate()
	if err != nil || !bytes.Equal(original, got) {
		t.Fatalf("expected the fallback file's key, got err = %v", err)
	}
}

func TestLoadOrCreateRejectsCorruptKeyMaterial(t *testing.T) {
	keyring.MockInit()
	dir := t.TempDir()
	if err := writeFile(filepath.Join(dir, identityFileName), []byte("not-a-key")); err != nil {
		t.Fatal(err)
	}
	if _, err := NewIdentity(dir).LoadOrCreate(); err == nil {
		t.Fatal("expected an error for corrupt key material")
	}
}

func TestLoadOrCreateSurfacesTheKeychainErrorWhenTheFileAlsoFails(t *testing.T) {
	lockedKeychain(t)
	// A regular file where a directory should be makes the fallback unwritable.
	obstacle := filepath.Join(t.TempDir(), "obstacle")
	if err := os.WriteFile(obstacle, []byte("x"), 0o600); err != nil {
		t.Fatal(err)
	}
	_, err := NewIdentity(filepath.Join(obstacle, "modelhub")).LoadOrCreate()
	if err == nil || !strings.Contains(err.Error(), "locked") {
		t.Fatalf("expected an error mentioning the keychain failure, got %v", err)
	}
}

func TestLoadNeverCreatesAnIdentity(t *testing.T) {
	keyring.MockInit()
	dir := t.TempDir()
	if _, err := NewIdentity(dir).Load(); !errors.Is(err, ErrNoIdentity) {
		t.Fatalf("Load on a node with no identity = %v, want ErrNoIdentity", err)
	}
	assertNoFile(t, filepath.Join(dir, identityFileName))
}

func TestLoadDoesNotClaimAbsenceWhenTheKeychainIsUnusable(t *testing.T) {
	lockedKeychain(t)
	_, err := NewIdentity(t.TempDir()).Load()
	if err == nil || errors.Is(err, ErrNoIdentity) || !strings.Contains(err.Error(), "locked") {
		t.Fatalf("a locked keychain must surface as its own error, not ErrNoIdentity; got %v", err)
	}
}

func TestKeyringAccountIsScopedByConfigDir(t *testing.T) {
	base := t.TempDir()
	one, two := filepath.Join(base, "one"), filepath.Join(base, "two")
	if keyringAccount(one) == keyringAccount(two) {
		t.Fatal("different config dirs share a keychain account")
	}
	if keyringAccount(one) != keyringAccount(one+string(filepath.Separator)) {
		t.Fatal("the same config dir, spelled differently, got a different account")
	}
}

func TestDeleteRemovesBothBackendsAndIsIdempotent(t *testing.T) {
	keyring.MockInit()
	dir := t.TempDir()
	id := NewIdentity(dir)
	if _, err := id.LoadOrCreate(); err != nil {
		t.Fatalf("LoadOrCreate: %v", err)
	}
	if err := writeFile(id.file(), []byte("stale fallback")); err != nil {
		t.Fatal(err)
	}

	for i := 0; i < 2; i++ {
		if err := id.Delete(); err != nil {
			t.Fatalf("Delete #%d: %v", i+1, err)
		}
	}
	if _, err := keyring.Get(keyringService, id.account); !errors.Is(err, keyring.ErrNotFound) {
		t.Fatalf("keychain entry survived Delete: %v", err)
	}
	assertNoFile(t, id.file())
}

func TestDeleteStillRemovesTheFileWhenTheKeychainFails(t *testing.T) {
	lockedKeychain(t)
	id := NewIdentity(t.TempDir())
	if err := writeFile(id.file(), []byte("key")); err != nil {
		t.Fatal(err)
	}
	if err := id.Delete(); err == nil || !strings.Contains(err.Error(), "locked") {
		t.Fatalf("expected the keychain failure to be reported, got %v", err)
	}
	assertNoFile(t, id.file())
}
