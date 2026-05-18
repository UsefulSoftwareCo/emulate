package main

import (
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"os"
	"strconv"
	"strings"

	emuruntime "github.com/vercel-labs/emulate/internal/runtime"
)

var version = "dev"

var configFilenames = []string{
	"emulate.config.yaml",
	"emulate.config.yml",
	"emulate.config.json",
	"service-emulator.config.yaml",
	"service-emulator.config.yml",
	"service-emulator.config.json",
}

func main() {
	os.Exit(run(os.Args[1:], os.Stdout, os.Stderr))
}

func run(args []string, stdout io.Writer, stderr io.Writer) int {
	if len(args) == 0 {
		return runStart(nil, stdout, stderr)
	}

	switch args[0] {
	case "-h", "--help", "help":
		printHelp(stdout)
		return 0
	case "-v", "--version", "version":
		fmt.Fprintf(stdout, "emulate %s\n", version)
		return 0
	case "start":
		return runStart(args[1:], stdout, stderr)
	case "init":
		return runInit(args[1:], stdout, stderr)
	case "list", "list-services":
		return runList(stdout)
	default:
		if strings.HasPrefix(args[0], "-") {
			return runStart(args, stdout, stderr)
		}
		fmt.Fprintf(stderr, "Unknown command: %s\n", args[0])
		printHelp(stderr)
		return 1
	}
}

func runStart(args []string, stdout io.Writer, stderr io.Writer) int {
	defaultPort := getenv("EMULATE_PORT", getenv("PORT", "4000"))
	fs := flag.NewFlagSet("start", flag.ContinueOnError)
	fs.SetOutput(stderr)

	portValue := fs.String("port", defaultPort, "Base port")
	fs.StringVar(portValue, "p", defaultPort, "Base port")
	serviceValue := fs.String("service", "", "Comma-separated services to enable")
	fs.StringVar(serviceValue, "s", "", "Comma-separated services to enable")
	seedValue := fs.String("seed", "", "Path to seed config file")
	baseURLValue := fs.String("base-url", "", "Override advertised base URL")
	portlessValue := fs.Bool("portless", false, "Serve over HTTPS via portless")

	if err := fs.Parse(args); err != nil {
		if errors.Is(err, flag.ErrHelp) {
			return 0
		}
		return 1
	}

	port, err := strconv.Atoi(*portValue)
	if err != nil || port < 1 || port > 65535 {
		fmt.Fprintf(stderr, "Invalid port: %s\n", *portValue)
		return 1
	}
	if *portlessValue && *baseURLValue != "" {
		fmt.Fprintln(stderr, "--portless and --base-url are mutually exclusive.")
		return 1
	}
	if err := validateServices(*serviceValue); err != nil {
		fmt.Fprintln(stderr, err)
		return 1
	}

	fmt.Fprintf(stdout, "emulate %s native Go runtime is experimental.\n", version)
	fmt.Fprintf(stdout, "start is not implemented yet in the native Go runtime.\n")
	fmt.Fprintf(stdout, "Requested base port: %d\n", port)
	if *serviceValue != "" {
		fmt.Fprintf(stdout, "Requested services: %s\n", *serviceValue)
	}
	if *seedValue != "" {
		fmt.Fprintf(stdout, "Requested seed: %s\n", *seedValue)
	}
	return 1
}

func runInit(args []string, stdout io.Writer, stderr io.Writer) int {
	fs := flag.NewFlagSet("init", flag.ContinueOnError)
	fs.SetOutput(stderr)

	serviceValue := fs.String("service", "all", "Service to generate config for")
	fs.StringVar(serviceValue, "s", "all", "Service to generate config for")
	if err := fs.Parse(args); err != nil {
		if errors.Is(err, flag.ErrHelp) {
			return 0
		}
		return 1
	}

	config, err := emuruntime.StarterConfig(*serviceValue)
	if err != nil {
		fmt.Fprintf(stderr, "%s. Available: %s, all\n", err, strings.Join(emuruntime.ServiceNames(), ", "))
		return 1
	}

	filename, err := existingConfigFile()
	if err != nil {
		fmt.Fprintf(stderr, "Failed to check %s: %v\n", filename, err)
		return 1
	}
	if filename != "" {
		fmt.Fprintf(stderr, "Config file already exists: %s\n", filename)
		return 1
	}

	content, err := json.MarshalIndent(config, "", "  ")
	if err != nil {
		fmt.Fprintf(stderr, "Failed to encode starter config: %v\n", err)
		return 1
	}
	content = append(content, '\n')
	const targetFilename = "emulate.config.yaml"
	if err := os.WriteFile(targetFilename, content, 0o644); err != nil {
		fmt.Fprintf(stderr, "Failed to write %s: %v\n", targetFilename, err)
		return 1
	}

	fmt.Fprintf(stdout, "Created %s\n", targetFilename)
	fmt.Fprintln(stdout, "\nRun 'npx emulate' to start the emulator.")
	return 0
}

func runList(stdout io.Writer) int {
	fmt.Fprintln(stdout)
	fmt.Fprintln(stdout, "Available services:")
	fmt.Fprintln(stdout)
	for _, service := range emuruntime.Services {
		fmt.Fprintf(stdout, "  %-10s%s\n", service.Name, service.Label)
		fmt.Fprintf(stdout, "            Endpoints: %s\n\n", service.Endpoints)
	}
	return 0
}

func printHelp(w io.Writer) {
	fmt.Fprintf(w, "emulate %s native Go runtime experimental\n\n", version)
	fmt.Fprintln(w, "Usage:")
	fmt.Fprintln(w, "  npx emulate [start] [--port <port>] [--service <services>] [--seed <file>]")
	fmt.Fprintln(w, "  npx emulate init [--service <service>]")
	fmt.Fprintln(w, "  npx emulate list")
	fmt.Fprintln(w, "\nThe published TypeScript CLI remains the default user-facing runtime.")
	fmt.Fprintln(w, "Use npx emulate for current production behavior.")
}

func validateServices(value string) error {
	if value == "" {
		return nil
	}
	for _, service := range strings.Split(value, ",") {
		name := strings.TrimSpace(service)
		if _, ok := emuruntime.FindService(name); !ok {
			return fmt.Errorf("Unknown service: %s", name)
		}
	}
	return nil
}

func getenv(name string, fallback string) string {
	if value := os.Getenv(name); value != "" {
		return value
	}
	return fallback
}

func existingConfigFile() (string, error) {
	for _, filename := range configFilenames {
		if _, err := os.Stat(filename); err == nil {
			return filename, nil
		} else if !errors.Is(err, os.ErrNotExist) {
			return filename, err
		}
	}
	return "", nil
}
