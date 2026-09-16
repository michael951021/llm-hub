package version

// Version is overwritten at build time:
//
//	-ldflags "-X github.com/modelhub/agent/internal/version.Version=1.2.3"
var Version = "0.0.0-dev"
