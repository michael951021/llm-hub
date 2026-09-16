package transport

import (
	"crypto/ed25519"
	"crypto/rand"
	"encoding/base64"
	"strconv"
	"strings"
	"testing"
	"time"
)

func TestAuthHeaderMatchesTheServerFormat(t *testing.T) {
	pub, priv, _ := ed25519.GenerateKey(rand.Reader)
	now := time.UnixMilli(1_700_000_000_000)

	header := AuthHeader("node-abc", priv, now)

	if !strings.HasPrefix(header, "ModelHubNode ") {
		t.Fatalf("header does not carry the scheme: %q", header)
	}
	parts := strings.Split(strings.TrimPrefix(header, "ModelHubNode "), ".")
	if len(parts) != 4 {
		t.Fatalf("expected 4 dot-separated parts, got %d", len(parts))
	}

	if parts[0] != "node-abc" {
		t.Errorf("node id = %q", parts[0])
	}
	if ms, err := strconv.ParseInt(parts[1], 10, 64); err != nil || ms != now.UnixMilli() {
		t.Errorf("timestamp = %q, want %d", parts[1], now.UnixMilli())
	}

	signature, err := base64.RawURLEncoding.DecodeString(parts[3])
	if err != nil {
		t.Fatalf("signature is not base64url: %v", err)
	}
	payload := strings.Join(parts[:3], ".")
	if !ed25519.Verify(pub, []byte(payload), signature) {
		t.Fatal("signature does not verify against the signed payload")
	}
}

func TestAuthHeaderUsesAFreshNonceEveryTime(t *testing.T) {
	_, priv, _ := ed25519.GenerateKey(rand.Reader)
	now := time.Now()

	first := AuthHeader("node-abc", priv, now)
	second := AuthHeader("node-abc", priv, now)

	if first == second {
		t.Fatal("two headers with the same timestamp were identical; the nonce is not fresh")
	}
}
