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
	"os"
	"path/filepath"
	"strings"

	"github.com/zalando/go-keyring"
)

const keyringService = "com.modelhub.agent"

type Identity interface {
	// LoadOrCreate returns the stored private key, generating and persisting
	// one on first use.
	LoadOrCreate() (ed25519.PrivateKey, error)

	// Delete removes any stored identity, leaving no key material behind.
	// Calling it when no identity exists is not an error.
	Delete() error
}

type fileIdentity struct{ dir string }

func NewFileIdentity(dir string) Identity { return &fileIdentity{dir: dir} }

func (f *fileIdentity) LoadOrCreate() (ed25519.PrivateKey, error) {
	path := filepath.Join(f.dir, identityFileName)
	data, err := os.ReadFile(path)
	switch {
	case err == nil:
		return decodeKey(strings.TrimSpace(string(data)))
	case errors.Is(err, fs.ErrNotExist):
		_, priv, genErr := ed25519.GenerateKey(rand.Reader)
		if genErr != nil {
			return nil, genErr
		}
		encoded := base64.StdEncoding.EncodeToString(priv)
		if writeErr := writeFile(path, []byte(encoded)); writeErr != nil {
			return nil, writeErr
		}
		return priv, nil
	default:
		return nil, err
	}
}

func (f *fileIdentity) Delete() error {
	err := os.Remove(filepath.Join(f.dir, identityFileName))
	if err != nil && !errors.Is(err, fs.ErrNotExist) {
		return err
	}
	return nil
}

type keyringIdentity struct {
	account  string
	fallback Identity
}

// NewIdentity prefers the OS keychain and falls back to a 0600 file when no
// keychain is available — a headless Linux box, or a locked login keyring.
//
// The keychain account is scoped by dir (see keyringAccount) so that two
// config directories on the same machine — a fresh identity after
// uninstall/re-enroll, or two independent agent instances — never collide
// on a single keychain entry.
func NewIdentity(dir string) Identity {
	return &keyringIdentity{account: keyringAccount(dir), fallback: NewFileIdentity(dir)}
}

// keyringAccount derives a stable keychain account name from a config
// directory. It hashes the resolved absolute path rather than using the
// path itself because some keychain backends (and `security` on the
// command line) are awkward with account names containing slashes. The
// truncated SHA-256 is a uniqueness hash for namespacing distinct config
// dirs apart, not a security boundary — nothing sensitive is derived from
// or protected by it.
func keyringAccount(dir string) string {
	resolved := dir
	if abs, err := filepath.Abs(dir); err == nil {
		resolved = abs
	}
	sum := sha256.Sum256([]byte(resolved))
	return "node-key-" + hex.EncodeToString(sum[:8])
}

func (k *keyringIdentity) LoadOrCreate() (ed25519.PrivateKey, error) {
	stored, err := keyring.Get(keyringService, k.account)
	if err == nil {
		return decodeKey(stored)
	}
	if !errors.Is(err, keyring.ErrNotFound) {
		// The keychain exists but couldn't be used (e.g. it's locked) —
		// distinct from ErrNotFound, where falling back silently is fine.
		// If the fallback also fails, surface both causes: a bare file
		// error here would hide the keychain problem, which is usually
		// the one the user actually needs to act on.
		priv, fbErr := k.fallback.LoadOrCreate()
		if fbErr != nil {
			return nil, fmt.Errorf("keychain unavailable (%w), and the fallback file identity also failed: %w", err, fbErr)
		}
		return priv, nil
	}

	_, priv, genErr := ed25519.GenerateKey(rand.Reader)
	if genErr != nil {
		return nil, genErr
	}
	if setErr := keyring.Set(keyringService, k.account, base64.StdEncoding.EncodeToString(priv)); setErr != nil {
		return k.fallback.LoadOrCreate()
	}
	return priv, nil
}

// Delete removes both the keychain entry and the file fallback, so an
// uninstall genuinely leaves no key material behind regardless of which
// backend LoadOrCreate happened to use. The two are attempted
// unconditionally and independently of one another — LoadOrCreate falls
// back to the file precisely when the keychain "exists but couldn't be
// used" (e.g. a headless Linux box with no secret-service, or a locked
// login keyring), which is exactly the situation where the file, not the
// keychain, holds the real key. Returning early after a keychain error
// would skip the fallback delete in precisely that case.
func (k *keyringIdentity) Delete() error {
	kErr := keyring.Delete(keyringService, k.account)
	if errors.Is(kErr, keyring.ErrNotFound) {
		kErr = nil
	}
	fbErr := k.fallback.Delete()
	switch {
	case kErr != nil && fbErr != nil:
		return fmt.Errorf("could not remove keychain entry (%w), and could not remove the fallback identity file: %w", kErr, fbErr)
	case kErr != nil:
		return fmt.Errorf("could not remove keychain entry: %w", kErr)
	case fbErr != nil:
		return fmt.Errorf("could not remove fallback identity file: %w", fbErr)
	}
	return nil
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
