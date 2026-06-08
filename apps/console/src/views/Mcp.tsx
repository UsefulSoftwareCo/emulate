import SpecPanel from "../components/SpecPanel";
import { serviceById } from "../services";

// GitHub MCP is a surface of the github service (shared store), addressed at
// /github/<inst>/mcp — so this view has no instance bar of its own; it points at
// the connection-type routes and lists the tools.
const TOOLS: Array<[string, string]> = [
  ["get_me", "Get the authenticated GitHub user."],
  ["list_repositories", "List repositories owned by the authenticated user."],
  ["get_repository", "Get details of a repository."],
  ["list_issues", "List issues in a repository."],
  ["create_issue", "Create a new issue in a repository."],
  ["search_repositories", "Search repositories by name or description."],
];

export default function Mcp() {
  const svc = serviceById("mcp")!;
  return (
    <>
      <h1>GitHub MCP</h1>
      <p className="lead">
        A real MCP server exposing GitHub tools over the same store as the GitHub REST/GraphQL emulator — it's a third
        surface of the <b>github</b> service, at <code>/github/&lt;instance&gt;/mcp</code>. Pick the connection type by
        URL: OAuth (DCR) works out of the box; bearer/query use a demo token.
      </p>

      <SpecPanel svc={svc} instance="" />

      <div className="panel">
        <div className="ph"><h2>Tools</h2></div>
        {TOOLS.map(([name, desc]) => (
          <div className="cred" key={name}>
            <b>{name}</b> — {desc}
          </div>
        ))}
      </div>
    </>
  );
}
