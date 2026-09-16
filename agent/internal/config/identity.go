package config

import (
	"crypto/ed25519"
	"crypto/rand"
	"encoding/base64"
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

type keyringIdentity struct {
	account  string
	fallback Identity
}

// NewIdentity prefers the OS keychain and falls back to a 0600 file when no
// keychain is available — a headless Linux box, or a locked login keyring.
func NewIdentity(dir string) Identity {
	return &keyringIdentity{account: "node-key", fallback: NewFileIdentity(dir)}
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
