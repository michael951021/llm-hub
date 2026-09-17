package config

import (
	"bytes"
	"crypto/ed25519"
	"errors"
	"io/fs"
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

// TestKeyringAccountDiffersByConfigDir is the regression test for the bug
// fixed in Task 19: NewIdentity used to key every keychain entry off a
// fixed account name regardless of dir, so a fresh enroll after uninstall
// (or two agent instances with different config dirs) silently reused the
// same stored key. The account must now be derived from the resolved
// config directory.
func TestKeyringAccountDiffersByConfigDir(t *testing.T) {
	a := keyringAccount(filepath.Join(t.TempDir(), "one"))
	b := keyringAccount(filepath.Join(t.TempDir(), "two"))
	if a == b {
		t.Fatalf("expected different keyring accounts for different config dirs, both got %q", a)
	}
}

// TestKeyringAccountStableForSameConfigDir ensures the account name is
// deterministic for a given directory (e.g. across process restarts),
// including when the same logical path is spelled differently.
func TestKeyringAccountStableForSameConfigDir(t *testing.T) {
	dir := t.TempDir()
	a := keyringAccount(dir)
	b := keyringAccount(dir + string(filepath.Separator))
	if a != b {
		t.Fatalf("expected the same keyring account for the same dir, got %q and %q", a, b)
	}
}

// TestKeyringIdentityDeleteRemovesBothBackends proves that Delete leaves no
// key material behind: it removes the keychain entry, and it removes the
// file-fallback key too (in case the fallback was what actually got used,
// e.g. because the keychain was briefly unavailable when the key was
// created). This is what makes `uninstall` honest.
func TestKeyringIdentityDeleteRemovesBothBackends(t *testing.T) {
	keyring.MockInit()
	dir := t.TempDir()
	id := NewIdentity(dir)

	if _, err := id.LoadOrCreate(); err != nil {
		t.Fatalf("LoadOrCreate: %v", err)
	}

	ki := id.(*keyringIdentity)
	if _, err := keyring.Get(keyringService, ki.account); err != nil {
		t.Fatalf("expected a keychain entry to exist before Delete, got: %v", err)
	}

	if err := id.Delete(); err != nil {
		t.Fatalf("Delete: %v", err)
	}

	if _, err := keyring.Get(keyringService, ki.account); !errors.Is(err, keyring.ErrNotFound) {
		t.Fatalf("expected keychain entry to be gone after Delete, got: %v", err)
	}
	if _, err := os.Stat(filepath.Join(dir, identityFileName)); !errors.Is(err, fs.ErrNotExist) {
		t.Fatalf("expected no fallback identity file after Delete, stat err = %v", err)
	}
}

// TestKeyringIdentityDeleteIsIdempotent ensures a second Delete (e.g. an
// uninstall run twice) is not an error.
func TestKeyringIdentityDeleteIsIdempotent(t *testing.T) {
	keyring.MockInit()
	dir := t.TempDir()
	id := NewIdentity(dir)
	if err := id.Delete(); err != nil {
		t.Fatalf("Delete on a never-created identity: %v", err)
	}
	if _, err := id.LoadOrCreate(); err != nil {
		t.Fatalf("LoadOrCreate: %v", err)
	}
	if err := id.Delete(); err != nil {
		t.Fatalf("first Delete: %v", err)
	}
	if err := id.Delete(); err != nil {
		t.Fatalf("second Delete: %v", err)
	}
}

// TestKeyringIdentityDeleteStillRemovesFallbackWhenKeychainFails is the
// regression test for the bug found in review: Delete used to return as
// soon as keyring.Delete failed for any reason other than ErrNotFound,
// which meant k.fallback.Delete() never ran. That is exactly the wrong
// branch to skip it on — LoadOrCreate falls back to the file precisely
// when the keychain "exists but couldn't be used" (a headless Linux box
// with no secret-service, or a locked login keyring), so a keychain
// failure here is often the signal that the file is where the real key
// actually lives. This proves the fallback file is removed even though
// the keychain half fails and surfaces an error.
func TestKeyringIdentityDeleteStillRemovesFallbackWhenKeychainFails(t *testing.T) {
	keyring.MockInitWithError(errors.New("keychain is locked"))
	t.Cleanup(keyring.MockInit)

	dir := t.TempDir()
	path := filepath.Join(dir, identityFileName)
	if err := writeFile(path, []byte("encoded-key-material")); err != nil {
		t.Fatalf("setup: %v", err)
	}

	err := NewIdentity(dir).Delete()
	if err == nil {
		t.Fatal("expected an error surfacing the keychain failure")
	}
	if !strings.Contains(err.Error(), "locked") {
		t.Errorf("error does not mention the keychain failure: %v", err)
	}
	if _, statErr := os.Stat(path); !errors.Is(statErr, fs.ErrNotExist) {
		t.Fatalf("expected the fallback identity file to be removed despite the keychain delete failing; stat err = %v", statErr)
	}
}

// TestKeyringIdentityDeleteWrapsBothErrorsOnDoubleFailure is Delete's
// analogue of TestKeyringIdentityWrapsBothErrorsOnDoubleFailure below: when
// both the keychain removal and the fallback file removal fail, the
// returned error must mention the keychain failure rather than reporting
// only the (usually less actionable) file error.
func TestKeyringIdentityDeleteWrapsBothErrorsOnDoubleFailure(t *testing.T) {
	keyring.MockInitWithError(errors.New("keychain is locked"))
	t.Cleanup(keyring.MockInit)

	dir := t.TempDir()
	// Make the fallback file un-removable: put a non-empty directory where
	// the identity file would be, so os.Remove fails (a non-empty
	// directory can't be removed) instead of silently succeeding or
	// no-opping as "already gone".
	path := filepath.Join(dir, identityFileName)
	if err := os.MkdirAll(path, 0o700); err != nil {
		t.Fatalf("setup: %v", err)
	}
	if err := os.WriteFile(filepath.Join(path, "occupied"), []byte("x"), 0o600); err != nil {
		t.Fatalf("setup: %v", err)
	}

	err := NewIdentity(dir).Delete()
	if err == nil {
		t.Fatal("expected an error when both the keychain and the fallback file removal fail")
	}
	if !strings.Contains(err.Error(), "locked") {
		t.Errorf("error does not mention the keychain failure: %v", err)
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
