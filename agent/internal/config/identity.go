package config

import (
	"crypto/ed25519"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"fmt"
	"io/fs"
	"log/slog"
	"os"
	"path/filepath"
	"strings"

	"github.com/zalando/go-keyring"
)

const keyringService = "com.modelhub.agent"

// ErrNoIdentity reports that no key is stored for this config directory.
// Enrollment treats it as "first run"; everything else as broken local state.
var ErrNoIdentity = errors.New("no stored identity for this config directory")

// Identity is this node's Ed25519 private key. It lives in the OS keychain,
// or in a 0600 file in the config directory when no keychain is usable
// (a headless Linux box, a locked login keyring).
type Identity struct {
	dir     string
	account string
}

func NewIdentity(dir string) *Identity {
	return &Identity{dir: dir, account: keyringAccount(dir)}
}

// keyringAccount scopes the keychain entry by config directory, so a
// re-enrolled node or a second agent instance never reuses another's key.
// Hashed because some keychain backends mishandle slashes in account names.
func keyringAccount(dir string) string {
	if abs, err := filepath.Abs(dir); err == nil {
		dir = abs
	}
	sum := sha256.Sum256([]byte(dir))
	return "node-key-" + hex.EncodeToString(sum[:8])
}

func (id *Identity) file() string { return filepath.Join(id.dir, identityFileName) }

// Load returns the stored key, or ErrNoIdentity. It never generates one:
// a fresh key for an already-enrolled node is one the server has never seen.
//
// A keychain that can't be read is never reported as ErrNoIdentity. Callers
// turn that into "re-enroll", which would throw away a good key.
func (id *Identity) Load() (ed25519.PrivateKey, error) {
	stored, keyErr := keyring.Get(keyringService, id.account)
	if keyErr == nil {
		return decodeKey(stored)
	}
	priv, fileErr := id.loadFile()
	switch {
	case fileErr == nil || errors.Is(keyErr, keyring.ErrNotFound):
		return priv, fileErr
	case errors.Is(fileErr, ErrNoIdentity):
		return nil, fmt.Errorf("keychain unavailable (%w), and there is no fallback identity file either", keyErr)
	default:
		return nil, fmt.Errorf("keychain unavailable (%w), and the fallback identity file also failed: %w", keyErr, fileErr)
	}
}

// LoadOrCreate returns the stored key, generating and storing one if there
// is none. Only enrollment should call it: enrolling is what registers the
// new public key with the server.
func (id *Identity) LoadOrCreate() (ed25519.PrivateKey, error) {
	stored, keyErr := keyring.Get(keyringService, id.account)
	if keyErr == nil {
		return decodeKey(stored)
	}
	keychainUsable := errors.Is(keyErr, keyring.ErrNotFound)
	priv, err := id.loadOrCreateFallback(keychainUsable)
	if err != nil && !keychainUsable {
		return nil, fmt.Errorf("keychain unavailable (%w), and the fallback identity file also failed: %w", keyErr, err)
	}
	return priv, err
}

// An existing file always wins over minting a key: it may be this node's
// real identity, written while the keychain was unavailable.
func (id *Identity) loadOrCreateFallback(keychainUsable bool) (ed25519.PrivateKey, error) {
	if priv, err := id.loadFile(); !errors.Is(err, ErrNoIdentity) {
		return priv, err
	}
	_, priv, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		return nil, err
	}
	encoded := base64.StdEncoding.EncodeToString(priv)
	if keychainUsable {
		setErr := keyring.Set(keyringService, id.account, encoded)
		if setErr == nil {
			return priv, nil
		}
		slog.Warn("could not store this node's identity in the OS keychain; falling back to a 0600 file",
			"error", setErr, "account", id.account)
	}
	if err := writeFile(id.file(), []byte(encoded)); err != nil {
		return nil, err
	}
	return priv, nil
}

// Delete removes both the keychain entry and the file, independently: when
// the keychain fails, the file is exactly where the real key is likely to be.
// Deleting an identity that doesn't exist is not an error.
func (id *Identity) Delete() error {
	var errs []error
	if err := keyring.Delete(keyringService, id.account); err != nil && !errors.Is(err, keyring.ErrNotFound) {
		errs = append(errs, fmt.Errorf("could not remove keychain entry: %w", err))
	}
	if err := os.Remove(id.file()); err != nil && !errors.Is(err, fs.ErrNotExist) {
		errs = append(errs, fmt.Errorf("could not remove fallback identity file: %w", err))
	}
	return errors.Join(errs...)
}

func (id *Identity) loadFile() (ed25519.PrivateKey, error) {
	data, err := os.ReadFile(id.file())
	if errors.Is(err, fs.ErrNotExist) {
		return nil, ErrNoIdentity
	}
	if err != nil {
		return nil, err
	}
	return decodeKey(strings.TrimSpace(string(data)))
}

func decodeKey(encoded string) (ed25519.PrivateKey, error) {
	raw, err := base64.StdEncoding.DecodeString(encoded)
	if err != nil {
		return nil, fmt.Errorf("stored identity is not valid base64: %w", err)
	}
	if len(raw) != ed25519.PrivateKeySize {
		return nil, fmt.Errorf("stored identity is %d bytes, want %d", len(raw), ed25519.PrivateKeySize)
	}
	return ed25519.PrivateKey(raw), nil
}
