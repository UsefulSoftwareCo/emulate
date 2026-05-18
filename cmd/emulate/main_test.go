package main

import (
	"bytes"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestRunListIncludesRegisteredServices(t *testing.T) {
	var stdout, stderr bytes.Buffer
	code := run([]string{"list"}, &stdout, &stderr)
	if code != 0 {
		t.Fatalf("list exited with %d, stderr: %s", code, stderr.String())
	}
	out := stdout.String()
	for _, service := range []string{"github", "aws", "stripe", "clerk"} {
		if !strings.Contains(out, service) {
			t.Fatalf("list output missing %q:\n%s", service, out)
		}
	}
	if !strings.Contains(out, "  mongoatlas  MongoDB Atlas service emulator") {
		t.Fatalf("list output did not separate longest service name from label:\n%s", out)
	}
}

func TestRunListHelpExitsSuccessfully(t *testing.T) {
	var stdout, stderr bytes.Buffer
	code := run([]string{"list", "--help"}, &stdout, &stderr)
	if code != 0 {
		t.Fatalf("list help exited with %d, stderr: %s", code, stderr.String())
	}
	if !strings.Contains(stderr.String(), "Usage of list:") {
		t.Fatalf("unexpected stderr: %s", stderr.String())
	}
	if strings.Contains(stdout.String(), "Available services") {
		t.Fatalf("list printed services for help:\n%s", stdout.String())
	}
}

func TestRunListRejectsUnexpectedArgument(t *testing.T) {
	var stdout, stderr bytes.Buffer
	code := run([]string{"list", "extra"}, &stdout, &stderr)
	if code == 0 {
		t.Fatal("list with unexpected argument exited successfully")
	}
	if !strings.Contains(stderr.String(), "Unexpected argument: extra") {
		t.Fatalf("unexpected stderr: %s", stderr.String())
	}
	if strings.Contains(stdout.String(), "Available services") {
		t.Fatalf("list printed services after unexpected argument:\n%s", stdout.String())
	}
}

func TestRunStartRejectsInvalidPort(t *testing.T) {
	var stdout, stderr bytes.Buffer
	code := run([]string{"start", "--port", "70000"}, &stdout, &stderr)
	if code == 0 {
		t.Fatal("start with invalid port exited successfully")
	}
	if !strings.Contains(stderr.String(), "Invalid port: 70000") {
		t.Fatalf("unexpected stderr: %s", stderr.String())
	}
}

func TestRunStartRejectsUnexpectedArgument(t *testing.T) {
	var stdout, stderr bytes.Buffer
	code := run([]string{"start", "github", "--port", "4010"}, &stdout, &stderr)
	if code == 0 {
		t.Fatal("start with unexpected argument exited successfully")
	}
	if !strings.Contains(stderr.String(), "Unexpected argument: github") {
		t.Fatalf("unexpected stderr: %s", stderr.String())
	}
	if strings.Contains(stdout.String(), "Requested base port") {
		t.Fatalf("start continued after unexpected argument:\n%s", stdout.String())
	}
}

func TestRunStartHelpExitsSuccessfully(t *testing.T) {
	var stdout, stderr bytes.Buffer
	code := run([]string{"start", "--help"}, &stdout, &stderr)
	if code != 0 {
		t.Fatalf("start help exited with %d, stderr: %s", code, stderr.String())
	}
	if !strings.Contains(stderr.String(), "Usage of start:") {
		t.Fatalf("unexpected stderr: %s", stderr.String())
	}
}

func TestRunInitHelpExitsSuccessfully(t *testing.T) {
	var stdout, stderr bytes.Buffer
	code := run([]string{"init", "--help"}, &stdout, &stderr)
	if code != 0 {
		t.Fatalf("init help exited with %d, stderr: %s", code, stderr.String())
	}
	if !strings.Contains(stderr.String(), "Usage of init:") {
		t.Fatalf("unexpected stderr: %s", stderr.String())
	}
}

func TestRunInitRejectsUnexpectedArgument(t *testing.T) {
	tempDir := t.TempDir()
	oldDir, err := os.Getwd()
	if err != nil {
		t.Fatal(err)
	}
	if err := os.Chdir(tempDir); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if err := os.Chdir(oldDir); err != nil {
			t.Fatal(err)
		}
	})

	var stdout, stderr bytes.Buffer
	code := run([]string{"init", "aws"}, &stdout, &stderr)
	if code == 0 {
		t.Fatal("init with unexpected argument exited successfully")
	}
	if !strings.Contains(stderr.String(), "Unexpected argument: aws") {
		t.Fatalf("unexpected stderr: %s", stderr.String())
	}
	if _, err := os.Stat(filepath.Join(tempDir, "emulate.config.yaml")); !os.IsNotExist(err) {
		t.Fatalf("unexpected config file stat error: %v", err)
	}
}

func TestRunInitWritesStarterConfig(t *testing.T) {
	tempDir := t.TempDir()
	oldDir, err := os.Getwd()
	if err != nil {
		t.Fatal(err)
	}
	if err := os.Chdir(tempDir); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if err := os.Chdir(oldDir); err != nil {
			t.Fatal(err)
		}
	})

	var stdout, stderr bytes.Buffer
	code := run([]string{"init", "--service", "aws"}, &stdout, &stderr)
	if code != 0 {
		t.Fatalf("init exited with %d, stderr: %s", code, stderr.String())
	}

	raw, err := os.ReadFile(filepath.Join(tempDir, "emulate.config.yaml"))
	if err != nil {
		t.Fatal(err)
	}
	content := string(raw)
	if strings.HasPrefix(content, "{") || strings.Contains(content, "\"tokens\"") {
		t.Fatalf("starter config was written as JSON:\n%s", content)
	}
	if !strings.HasPrefix(content, "tokens:\n") {
		t.Fatalf("starter config missing tokens YAML section:\n%s", content)
	}
	if !strings.Contains(content, "\naws:\n") {
		t.Fatalf("starter config missing aws YAML section:\n%s", content)
	}
	if strings.Contains(content, "\ngithub:\n") {
		t.Fatal("service-specific starter config included github")
	}
}

func TestRunInitRejectsExistingAutoDetectedConfig(t *testing.T) {
	tempDir := t.TempDir()
	oldDir, err := os.Getwd()
	if err != nil {
		t.Fatal(err)
	}
	if err := os.Chdir(tempDir); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if err := os.Chdir(oldDir); err != nil {
			t.Fatal(err)
		}
	})

	existing := filepath.Join(tempDir, "emulate.config.yaml")
	if err := os.WriteFile(existing, []byte("github: {}\n"), 0o644); err != nil {
		t.Fatal(err)
	}

	var stdout, stderr bytes.Buffer
	code := run([]string{"init", "--service", "aws"}, &stdout, &stderr)
	if code == 0 {
		t.Fatal("init with existing config exited successfully")
	}
	if !strings.Contains(stderr.String(), "Config file already exists: emulate.config.yaml") {
		t.Fatalf("unexpected stderr: %s", stderr.String())
	}
}
