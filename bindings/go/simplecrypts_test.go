package simplecrypts

import (
	"bytes"
	"math"
	"strconv"
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
	if role == "server" {
		peer = nil
	}
	e, err := Initialize(Config{Role: role, Storage: t.TempDir() + "/store", Serial: "sdk-go", Secret: bytes.Repeat([]byte{0x33}, 32), ProvisionedSeed: seed, ServerPublicKey: peer, RandomUnavailable: true})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(e.Close)
	return e
}
func TestCreditResources(t *testing.T) {
	d, s := fixture(t, "device"), fixture(t, "server")
	move := func(from, to *Endpoint) {
		t.Helper()
		frame, err := from.Outbound(512, 512)
		if err != nil {
			t.Fatal(err)
		}
		if err = to.Receive(frame); err != nil {
			t.Fatal(err)
		}
	}
	check := func(err error) {
		t.Helper()
		if err != nil {
			t.Fatal(err)
		}
	}
	move(d, s)
	move(s, d)
	check(s.SetCreditsIssued(math.MaxUint64))
	frame, err := s.Outbound(512, 512)
	check(err)
	saved := append([]byte(nil), frame...)
	old, err := d.Inspect()
	check(err)
	check(d.Receive(frame))
	move(d, s)
	move(s, d)
	const n = uint64(1<<53) + 19
	check(d.ConsumeCredits(n))
	out, err := d.Outbound(512, 512)
	check(err)
	if out != nil {
		t.Fatal("unsolicited report")
	}
	state, err := d.Inspect()
	check(err)
	if state["credits_consumed"] != strconv.FormatUint(n, 10) || old["credits_consumed"] != "0" || !bytes.Equal(saved, frame) {
		t.Fatal("ownership/precision")
	}
	if d.UpdateGroup(1, []ResourceValue{{FieldID: 1, Type: 1, Uint64: 10}}) == nil {
		t.Fatal("wrong owner")
	}
	check(s.RequestGroup(1))
	move(s, d)
	move(d, s)
	move(s, d)
	group, err := s.InspectGroup(1)
	check(err)
	if group["snapshot_id"] != "2" || group["values"].(map[uint16]any)[2].(uint64) != n {
		t.Fatal(group)
	}
	check(d.ConsumeCredits(math.MaxUint64 - n))
	if d.ConsumeCredits(1) == nil {
		t.Fatal("overflow")
	}
	d.Close()
	d.Close()
	if d.ConsumeCredits(1) == nil {
		t.Fatal("closed handle")
	}
}
