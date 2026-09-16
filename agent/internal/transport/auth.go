package transport

import (
	"crypto/ed25519"
	"crypto/rand"
	"encoding/base64"
	"fmt"
	"time"
)

// AuthHeader builds the value the control plane's authenticateNode expects:
//
//	ModelHubNode <nodeID>.<unixMillis>.<nonce>.<signature>
//
// where the signature covers the first three fields joined by dots. Keep this
// byte-for-byte in step with apps/control-plane/src/rpc/node-auth.ts: the
// server verifies against the raw header segments it received, not a
// re-serialization of them, so the signed payload here must be assembled
// from literally the same bytes that go into the header.
func AuthHeader(nodeID string, priv ed25519.PrivateKey, now time.Time) string {
	raw := make([]byte, 16)
	_, _ = rand.Read(raw)
	nonce := base64.RawURLEncoding.EncodeToString(raw)

	payload := fmt.Sprintf("%s.%d.%s", nodeID, now.UnixMilli(), nonce)
	signature := base64.RawURLEncoding.EncodeToString(ed25519.Sign(priv, []byte(payload)))

	return "ModelHubNode " + payload + "." + signature
}
