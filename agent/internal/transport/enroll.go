package transport

import (
	"context"
	"crypto/ed25519"
	"fmt"

	"connectrpc.com/connect"

	modelhubv1 "github.com/modelhub/agent/gen/modelhub/v1"
	"github.com/modelhub/agent/internal/inventory"
)

// EnrollResult is what the control plane returns on accepting this node.
type EnrollResult struct {
	NodeID  string
	OrgID   string
	OrgName string
}

// Enroll joins an organization using a pairing code from the web app. Only
// the public half of priv is sent; the private key never leaves the machine.
func Enroll(
	ctx context.Context,
	serverURL, pairingCode, nodeName string,
	priv ed25519.PrivateKey,
	host inventory.HostInfo,
) (*EnrollResult, error) {
	res, err := NewNodeClient(serverURL).Enroll(ctx, connect.NewRequest(&modelhubv1.EnrollRequest{
		PairingCode: pairingCode,
		PublicKey:   priv.Public().(ed25519.PublicKey),
		NodeName:    nodeName,
		Host:        hostProto(host),
	}))
	if err != nil {
		return nil, fmt.Errorf("enroll rejected: %w", err)
	}
	return &EnrollResult{NodeID: res.Msg.GetNodeId(), OrgID: res.Msg.GetOrgId(), OrgName: res.Msg.GetOrgName()}, nil
}
