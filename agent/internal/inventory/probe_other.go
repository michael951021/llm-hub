//go:build !darwin

package inventory

func newPlatformProbes() []Probe { return nil }
