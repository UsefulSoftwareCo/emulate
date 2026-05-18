package config

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"testing"
)

func TestLoadExplicitJSONConfig(t *testing.T) {
	dir := t.TempDir()
	configPath := filepath.Join(dir, "seed.json")
	if err := os.WriteFile(configPath, []byte(`{"tokens":{"t":{"login":"admin"}},"github":{"users":[]}}`), 0o644); err != nil {
		t.Fatal(err)
	}

	loaded, err := Load(LoadOptions{Path: configPath})
	if err != nil {
		t.Fatal(err)
	}
	if loaded.Format != FormatJSON {
		t.Fatalf("format = %s", loaded.Format)
	}
	if loaded.Filename != configPath {
		t.Fatalf("filename = %q", loaded.Filename)
	}
	if _, ok := loaded.Data["github"]; !ok {
		t.Fatalf("github config missing: %#v", loaded.Data)
	}
}

func TestLoadDiscoversCurrentConfigNamesInOrder(t *testing.T) {
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "service-emulator.config.json"), []byte(`{"stripe":{}}`), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "emulate.config.json"), []byte(`{"github":{}}`), 0o644); err != nil {
		t.Fatal(err)
	}

	loaded, err := Load(LoadOptions{Dir: dir})
	if err != nil {
		t.Fatal(err)
	}
	if loaded.Filename != "emulate.config.json" {
		t.Fatalf("discovered %q", loaded.Filename)
	}
	if services := InferServices(loaded.Data, []string{"github", "stripe"}); len(services) != 1 || services[0] != "github" {
		t.Fatalf("services = %#v", services)
	}
}

func TestLoadReportsYAMLAsUnsupportedForThisPhase(t *testing.T) {
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "emulate.config.yaml"), []byte("github: {}\n"), 0o644); err != nil {
		t.Fatal(err)
	}

	_, err := Load(LoadOptions{Dir: dir})
	if err == nil {
		t.Fatal("expected unsupported format error")
	}
	if !IsUnsupportedFormat(err) {
		t.Fatalf("expected unsupported format, got %v", err)
	}
}

func TestLoadMissingConfig(t *testing.T) {
	_, err := Load(LoadOptions{Dir: t.TempDir()})
	if !errors.Is(err, ErrNotFound) {
		t.Fatalf("expected ErrNotFound, got %v", err)
	}
}

func TestSortedKeys(t *testing.T) {
	keys := SortedKeys(map[string]json.RawMessage{
		"z": nil,
		"a": nil,
	})
	if len(keys) != 2 || keys[0] != "a" || keys[1] != "z" {
		t.Fatalf("keys = %#v", keys)
	}
}
