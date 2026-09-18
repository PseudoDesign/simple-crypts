// JSONL test adapter using the public Go SDK, one role per process.
package main

import (
	"bufio"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	sc "example.com/simplecrypts"
	"fmt"
	"os"
	"strconv"
	"strings"
)

func text(m map[string]json.RawMessage, key, fallback string) string {
	value, ok := m[key]
	if !ok {
		return fallback
	}
	var s string
	if json.Unmarshal(value, &s) != nil {
		return ""
	}
	return s
}
func integer(m map[string]json.RawMessage, key string, fallback int) (int, error) {
	v, ok := m[key]
	if !ok {
		return fallback, nil
	}
	var result int
	err := json.Unmarshal(v, &result)
	return result, err
}
func flag(m map[string]json.RawMessage, key string) bool {
	var b bool
	_ = json.Unmarshal(m[key], &b)
	return b
}
func bytes32(value string) ([]byte, error) {
	b, e := hex.DecodeString(value)
	if e == nil && len(b) != 32 {
		e = errors.New("invalid key")
	}
	return b, e
}
func perform(endpoint **sc.Endpoint, m map[string]json.RawMessage, result map[string]any) error {
	command := text(m, "command", text(m, "cmd", text(m, "op", "")))
	if command == "init" {
		if *endpoint != nil {
			return errors.New("already initialized")
		}
		secret, err := bytes32(text(m, "secret", strings.Repeat("33", 32)))
		if err != nil {
			return err
		}
		var seed []byte
		if raw, ok := m["key_seed"]; ok && string(raw) != "null" {
			seed, err = bytes32(text(m, "key_seed", ""))
			if err != nil {
				return err
			}
		}
		var server []byte
		if _, ok := m["server_public_key"]; ok {
			server, err = bytes32(text(m, "server_public_key", ""))
		} else {
			var serverSeed []byte
			serverSeed, err = bytes32(text(m, "server_seed", strings.Repeat("22", 32)))
			if err == nil {
				server, err = sc.FixturePublicKey(serverSeed)
			}
		}
		if err != nil {
			return err
		}
		*endpoint, err = sc.Initialize(sc.Config{Role: text(m, "role", ""), Storage: text(m, "storage", ""), Serial: text(m, "serial", "SAMPLE-001"), Secret: secret, ProvisionedSeed: seed, ServerPublicKey: server, RandomUnavailable: flag(m, "random_unavailable") || flag(m, "provision_without_random")})
		if err != nil {
			return err
		}
		if _, ok := m["initial_revision"]; ok {
			var revision uint64
			revision, err = strconv.ParseUint(text(m, "initial_revision", ""), 10, 64)
			if err == nil {
				err = (*endpoint).FixtureRevision(revision)
			}
		}
		return err
	}
	if *endpoint == nil {
		return errors.New("not initialized")
	}
	switch command {
	case "state":
		return nil
	case "close":
		(*endpoint).Close()
		*endpoint = nil
		return nil
	case "name":
		return (*endpoint).Name(text(m, "name", ""))
	case "report":
		v, err := integer(m, "temperature", 0)
		if _, ok := m["temperature"]; !ok {
			v, err = integer(m, "temperature_mC", 0)
		}
		if err != nil || int64(v) < -2147483648 || int64(v) > 2147483647 {
			return errors.New("invalid temperature")
		}
		return (*endpoint).Report(int32(v))
	case "rx":
		b, err := base64.StdEncoding.Strict().DecodeString(text(m, "frame", ""))
		if err != nil {
			return err
		}
		return (*endpoint).Receive(b)
	case "tx":
		budget, err := integer(m, "budget", 512)
		if err != nil {
			return err
		}
		capacity, err := integer(m, "capacity", 512)
		if err != nil {
			return err
		}
		frame, err := (*endpoint).Outbound(budget, capacity)
		if err != nil {
			return err
		}
		if frame == nil {
			result["status"] = "idle"
		} else {
			result["frame"] = base64.StdEncoding.EncodeToString(frame)
		}
		return nil
	case "fail":
		count, err := integer(m, "count", 1)
		if err != nil || count < 0 || uint64(count) > 4294967295 {
			return errors.New("invalid count")
		}
		return (*endpoint).Fail(text(m, "operation", ""), uint32(count))
	default:
		return errors.New("unknown command")
	}
}
func main() {
	var endpoint *sc.Endpoint
	defer func() {
		if endpoint != nil {
			endpoint.Close()
		}
	}()
	scanner := bufio.NewScanner(os.Stdin)
	scanner.Buffer(make([]byte, 4096), 65536)
	for scanner.Scan() {
		result := map[string]any{"status": "ok"}
		var item map[string]json.RawMessage
		err := json.Unmarshal(scanner.Bytes(), &item)
		if err == nil {
			err = perform(&endpoint, item, result)
		}
		if err != nil {
			var native *sc.Error
			if errors.As(err, &native) {
				result["status"] = native.Status
			} else {
				result["status"] = "invalid"
			}
		}
		if endpoint != nil {
			state, stateErr := endpoint.Inspect()
			if stateErr == nil {
				result["state"] = state
			}
		}
		output, _ := json.Marshal(result)
		fmt.Println(string(output))
	}
}
