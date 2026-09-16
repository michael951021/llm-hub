package inventory

import (
	"bytes"
	"context"
	"errors"
	"log/slog"
	"strings"
	"testing"
)

// TestSampleAllLogsTheFailingDeviceWithoutLosingItSilently guards finding 1
// from code review: a device that fails to sample must leave a trace (its
// LocalID and the error), not just vanish from the returned samples. This
// swaps the package-level slog default temporarily; it does not require
// injecting a logger into the package's public API.
func TestSampleAllLogsTheFailingDeviceWithoutLosingItSilently(t *testing.T) {
	var buf bytes.Buffer
	prev := slog.Default()
	slog.SetDefault(slog.New(slog.NewTextHandler(&buf, nil)))
	defer slog.SetDefault(prev)

	bad := NewFakeProbe(1)
	bad.SampleErr = errors.New("gpu fell off the bus")

	inv, err := Collect(context.Background(), []Probe{bad})
	if err != nil {
		t.Fatalf("Collect: %v", err)
	}
	if _, err := inv.SampleAll(context.Background()); err != nil {
		t.Fatalf("SampleAll: %v", err)
	}

	out := buf.String()
	wantLocalID := bad.Name() + ":0"
	if !strings.Contains(out, wantLocalID) {
		t.Errorf("log output missing failing device's LocalID %q; got: %s", wantLocalID, out)
	}
	if !strings.Contains(out, "gpu fell off the bus") {
		t.Errorf("log output missing the underlying error; got: %s", out)
	}
	if !strings.Contains(out, "WARN") {
		t.Errorf("expected a warn-level log record; got: %s", out)
	}
}
