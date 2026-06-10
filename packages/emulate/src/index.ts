import { Command } from "commander";
import { startCommand } from "./commands/start.js";
import { initCommand } from "./commands/init.js";
import { listCommand } from "./commands/list.js";

declare const PKG_VERSION: string;
const pkg = { version: PKG_VERSION };

const defaultPort = process.env.EMULATE_PORT ?? process.env.PORT ?? "4000";

const program = new Command();

program
  .name("emulate")
  .description("Local drop-in replacement services for CI and no-network sandboxes")
  .version(pkg.version);

program
  .command("start", { isDefault: true })
  .description("Start the emulator server")
  .option("-p, --port <port>", "Base port", defaultPort)
  .option("-s, --service <services>", "Comma-separated services to enable")
  .option("--seed <file>", "Path to seed config file")
  .option("--base-url <url>", "Override advertised base URL (supports {service} template)")
  .option("--portless", "Serve over HTTPS via portless (auto-registers aliases)")
  .addHelpText(
    "after",
    `

Control plane (under /_emulate on each service):
  GET  /_emulate              HTML landing page
  GET  /_emulate/manifest     machine-readable service manifest
  GET  /_emulate/quickstart   copy/paste getting-started snippet
  GET  /_emulate/specs        spec sources and coverage status
  GET  /_emulate/coverage     per-operation coverage and summary
  GET  /_emulate/connections  copyable SDK, CLI, env, and curl snippets
  GET  /_emulate/openapi      OpenAPI document (when supported)
  GET  /_emulate/graphql      GraphQL surface (when supported)
  GET  /_emulate/mcp          MCP surface (when supported)
  GET  /_emulate/state        current emulator state
  GET  /_emulate/ledger       request ledger (DELETE to clear)
  GET  /_emulate/logs         webhook deliveries and recent requests
  POST /_emulate/instances    create an instance
  POST /_emulate/seed         seed state
  POST /_emulate/reset        reset state
  POST /_emulate/credentials  mint a credential (bearer token, API key, or
                              OAuth client, depending on the service's auth)

Global catalog:
  GET /_emulate/services      machine-readable catalog of every hosted service

  Use /_emulate/manifest and /_emulate/coverage to discover supported surfaces
  and honest coverage, /_emulate/credentials to create credentials,
  /_emulate/seed to load fixtures, and /_emulate/ledger to validate API calls.

Hosted services:
  All 13 services are available on emulators.dev: github, vercel, google, okta,
  microsoft, spotify, slack, apple, aws, resend, stripe, mongoatlas, clerk,
  x, workos, autumn.
  Service host:    <service>.emulators.dev (useful without an instance; serves
                   a service-level /_emulate control plane)
  Instance host:   <service>.<instance>.emulators.dev
  Local/path form: <origin>/<service>/<instance>

  The apex emulators.dev is the catalog landing page that lists every emulator
  and links to its host. Per-service docs live at https://docs.emulators.dev/
  <service>.
`,
  )
  .action(async (opts) => {
    const port = parseInt(opts.port, 10);
    if (Number.isNaN(port) || port < 1 || port > 65535) {
      console.error(`Invalid port: ${opts.port}`);
      process.exit(1);
    }
    await startCommand({
      port,
      service: opts.service,
      seed: opts.seed,
      baseUrl: opts.baseUrl,
      portless: opts.portless,
    });
  });

program
  .command("init")
  .description("Generate a starter config file")
  .option("-s, --service <service>", "Service to generate config for", "all")
  .action((opts) => {
    initCommand({ service: opts.service });
  });

program
  .command("list")
  .alias("list-services")
  .description("List available services")
  .action(() => {
    listCommand();
  });

program.parse();
