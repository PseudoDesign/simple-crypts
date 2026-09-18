package simplecrypts

import (
	"bytes"
	"math"
	"strconv"
	"strings"
	"testing"
)

func fixture(t *testing.T, role string) *Endpoint {
	t.Helper()
	seed := bytes.Repeat([]byte{0x11}, 32)
	peer, err := FixturePublicKey(bytes.Repeat([]byte{0x22}, 32))
	if err != nil {
		t.Fatal(err)
	}
	if role == "server" {
		seed = bytes.Repeat([]byte{0x22}, 32)
	}
	e, err := Initialize(Config{Role: role, Storage: t.TempDir() + "/store", Serial: "sdk-go", Secret: bytes.Repeat([]byte{0x33}, 32), ProvisionedSeed: seed, ServerPublicKey: peer, RandomUnavailable: true})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(e.Close)
	return e
}
func TestOwnedDataAndClose(t *testing.T) {
	e := fixture(t, "device")
	if err := e.Report(1); err != nil {
		t.Fatal(err)
	}
	first, err := e.Outbound(512, 512)
	if err != nil {
		t.Fatal(err)
	}
	saved := append([]byte(nil), first...)
	state, err := e.Inspect()
	if err != nil {
		t.Fatal(err)
	}
	if err := e.Report(2); err != nil {
		t.Fatal(err)
	}
	second, err := e.Outbound(512, 512)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(first, saved) || bytes.Equal(first, second) {
		t.Fatal("frame ownership failed")
	}
	if state["reported_revision"] != "1" {
		t.Fatal("earlier state mutated")
	}
	e.Close()
	e.Close()
	if e.Report(3) == nil {
		t.Fatal("closed endpoint accepted report")
	}
	if _, err := e.Inspect(); err == nil {
		t.Fatal("closed endpoint inspected")
	}
}
func TestExactCountersAndErrors(t *testing.T) {
	e := fixture(t, "device")
	const revision = uint64(1<<53) + 19
	if err := e.FixtureRevision(revision); err != nil {
		t.Fatal(err)
	}
	if err := e.Report(math.MinInt32); err != nil {
		t.Fatal(err)
	}
	state, _ := e.Inspect()
	if state["reported_revision"] != strconv.FormatUint(revision+1, 10) {
		t.Fatal(state)
	}
	if err := e.Receive([]byte{1, 2, 3}); err == nil {
		t.Fatal("accepted short frame")
	}
	if _, err := e.Outbound(1, 1); err == nil {
		t.Fatal("accepted undersized buffer")
	}
	if _, err := FixturePublicKey(make([]byte, 31)); err == nil {
		t.Fatal("accepted short seed")
	}
	s := fixture(t, "server")
	if err := s.Name(strings.Repeat("x", 65)); err == nil {
		t.Fatal("accepted oversized name")
	}
	if err := s.Name("bad\x00name"); err == nil {
		t.Fatal("accepted NUL")
	}
	if err := s.Name("\xff"); err == nil {
		t.Fatal("accepted invalid UTF-8")
	}
}
func TestExhaustionDoesNotWrap(t *testing.T) {
	e := fixture(t, "device")
	if err := e.FixtureRevision(math.MaxUint64 - 1); err != nil {
		t.Fatal(err)
	}
	if err := e.Report(1); err != nil {
		t.Fatal(err)
	}
	if err := e.Report(2); err == nil {
		t.Fatal("counter wrapped")
	}
	state, _ := e.Inspect()
	if state["reported_revision"] != "18446744073709551615" || state["temperature"].(float64) != 1 {
		t.Fatal(state)
	}
}
