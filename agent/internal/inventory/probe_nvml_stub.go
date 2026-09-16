//go:build !nvml

package inventory

// Builds without the nvml tag have no CUDA support. The stub keeps
// DefaultProbes identical across platforms.
func newCUDAProbes() []Probe { return nil }
