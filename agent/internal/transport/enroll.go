package transport

import (
	"context"
	"crypto/ed25519"
	"fmt"

	"connectrpc.com/connect"

	modelhubv1 "github.com/modelhub/agent/gen/modelhub/v1"
	"github.com/modelhub/agent/internal/inventory"
	"github.com/modelhub/agent/internal/version"
)

// EnrollResult is what the control plane hands back once it has accepted
// this node into an organization.
type EnrollResult struct {
	NodeID  string
	OrgID   string
	OrgName string
}

func hostProto(h inventory.HostInfo) *modelhubv1.HostInfo {
	return &modelhubv1.HostInfo{
		Hostname:         h.Hostname,
		Platform:         h.Platform,
		Arch:             h.Arch,
		OsVersion:        h.OSVersion,
		AgentVersion:     version.Version,
		TotalMemoryBytes: h.TotalMemoryBytes,
		CpuCores:         uint32(h.CPUCores),
	}
}

// Enroll claims membership in an organization using a pairing code read off
// the web app. Only the public half of priv is ever sent — the private key
// never leaves this machine.
func Enroll(
	ctx context.Context,
	serverURL, pairingCode, nodeName string,
	priv ed25519.PrivateKey,
	host inventory.HostInfo,
) (*EnrollResult, error) {
	pub, ok := priv.Public().(ed25519.PublicKey)
	if !ok {
		return nil, fmt.Errorf("identity is not an Ed25519 key")
	}

	res, err := NewNodeClient(serverURL).Enroll(ctx, connect.NewRequest(&modelhubv1.EnrollRequest{
		PairingCode: pairingCode,
		PublicKey:   pub,
		NodeName:    nodeName,
		Host:        hostProto(host),
	}))
	if err != nil {
		return nil, fmt.Errorf("enroll rejected: %w", err)
	}

	return &EnrollResult{
		NodeID:  res.Msg.GetNodeId(),
		OrgID:   res.Msg.GetOrgId(),
		OrgName: res.Msg.GetOrgName(),
	}, nil
}
