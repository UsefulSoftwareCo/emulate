import type { AuthUser, Store } from "@emulators/core";
import { getGitHubStore, type GitHubStore } from "@emulators/github";
import type { GitHubIssue, GitHubRepo, GitHubUser } from "@emulators/github";

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

// Result of a tool invocation. `structuredContent` is surfaced as the structured
// payload; `text` is the human-readable JSON the MCP `content` array carries.
export interface ToolResult {
  structured: unknown;
  isError?: boolean;
}

interface ToolContext {
  store: Store;
  gh: GitHubStore;
  baseUrl: string;
  authUser: AuthUser;
  actor: GitHubUser;
}

// ---- lightweight formatters (MCP output, not the byte-exact REST shape) ----

function formatUser(user: GitHubUser, baseUrl: string) {
  return {
    login: user.login,
    id: user.id,
    node_id: user.node_id,
    type: user.type,
    name: user.name,
    company: user.company,
    blog: user.blog,
    location: user.location,
    email: user.email,
    bio: user.bio,
    twitter_username: user.twitter_username,
    public_repos: user.public_repos,
    followers: user.followers,
    following: user.following,
    site_admin: user.site_admin,
    html_url: `${baseUrl}/${user.login}`,
    avatar_url: user.avatar_url,
    created_at: user.created_at,
    updated_at: user.updated_at,
  };
}

function ownerLoginOf(gh: GitHubStore, repo: GitHubRepo): string {
  if (repo.owner_type === "User") return gh.users.get(repo.owner_id)?.login ?? "unknown";
  return gh.orgs.get(repo.owner_id)?.login ?? "unknown";
}

function formatRepo(repo: GitHubRepo, gh: GitHubStore, baseUrl: string) {
  const ownerLogin = ownerLoginOf(gh, repo);
  return {
    id: repo.id,
    node_id: repo.node_id,
    name: repo.name,
    full_name: repo.full_name,
    owner: { login: ownerLogin, id: repo.owner_id, type: repo.owner_type },
    private: repo.private,
    description: repo.description,
    fork: repo.fork,
    language: repo.language,
    default_branch: repo.default_branch,
    stargazers_count: repo.stargazers_count,
    watchers_count: repo.watchers_count,
    forks_count: repo.forks_count,
    open_issues_count: repo.open_issues_count,
    topics: repo.topics,
    visibility: repo.visibility,
    archived: repo.archived,
    html_url: `${baseUrl}/${repo.full_name}`,
    url: `${baseUrl}/repos/${repo.full_name}`,
    created_at: repo.created_at,
    updated_at: repo.updated_at,
    pushed_at: repo.pushed_at,
  };
}

function formatIssue(issue: GitHubIssue, gh: GitHubStore, baseUrl: string) {
  const repo = gh.repos.get(issue.repo_id);
  const user = gh.users.get(issue.user_id);
  const repoFullName = repo?.full_name ?? "unknown/unknown";
  return {
    id: issue.id,
    node_id: issue.node_id,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    state_reason: issue.state_reason,
    locked: issue.locked,
    comments: issue.comments,
    user: user ? { login: user.login, id: user.id, type: user.type } : null,
    html_url: `${baseUrl}/${repoFullName}/issues/${issue.number}`,
    url: `${baseUrl}/repos/${repoFullName}/issues/${issue.number}`,
    repository: repoFullName,
    created_at: issue.created_at,
    updated_at: issue.updated_at,
    closed_at: issue.closed_at,
  };
}

// ---- tool catalog (JSON-Schema inputSchema, mirroring github-mcp-server) ----

export const TOOL_DEFINITIONS: ToolDefinition[] = [
  {
    name: "get_me",
    description: "Get details of the authenticated GitHub user.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "list_repositories",
    description: "List repositories owned by the authenticated user.",
    inputSchema: {
      type: "object",
      properties: {
        perPage: { type: "number", description: "Results per page (max 100).", default: 30 },
        page: { type: "number", description: "Page number.", default: 1 },
      },
      additionalProperties: false,
    },
  },
  {
    name: "get_repository",
    description: "Get details of a repository.",
    inputSchema: {
      type: "object",
      properties: {
        owner: { type: "string", description: "Repository owner login." },
        name: { type: "string", description: "Repository name." },
      },
      required: ["owner", "name"],
      additionalProperties: false,
    },
  },
  {
    name: "list_issues",
    description: "List issues in a repository.",
    inputSchema: {
      type: "object",
      properties: {
        owner: { type: "string", description: "Repository owner login." },
        repo: { type: "string", description: "Repository name." },
        state: { type: "string", enum: ["open", "closed", "all"], default: "open" },
      },
      required: ["owner", "repo"],
      additionalProperties: false,
    },
  },
  {
    name: "create_issue",
    description: "Create a new issue in a repository.",
    inputSchema: {
      type: "object",
      properties: {
        owner: { type: "string", description: "Repository owner login." },
        repo: { type: "string", description: "Repository name." },
        title: { type: "string", description: "Issue title." },
        body: { type: "string", description: "Issue body (Markdown)." },
      },
      required: ["owner", "repo", "title"],
      additionalProperties: false,
    },
  },
  {
    name: "search_repositories",
    description: "Search for repositories by name or description.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Search query." },
      },
      required: ["query"],
      additionalProperties: false,
    },
  },
];

export class ToolError extends Error {}

function arg<T = unknown>(args: Record<string, unknown> | undefined, key: string): T | undefined {
  return args?.[key] as T | undefined;
}

function requireString(args: Record<string, unknown> | undefined, key: string): string {
  const v = arg(args, key);
  if (typeof v !== "string" || v.trim().length === 0) {
    throw new ToolError(`Missing or invalid argument: ${key}`);
  }
  return v;
}

function reposOwnedBy(gh: GitHubStore, userId: number): GitHubRepo[] {
  return gh.repos.all().filter((r) => r.owner_type === "User" && r.owner_id === userId);
}

const HANDLERS: Record<string, (ctx: ToolContext, args: Record<string, unknown> | undefined) => ToolResult> = {
  get_me(ctx) {
    return { structured: formatUser(ctx.actor, ctx.baseUrl) };
  },

  list_repositories(ctx, args) {
    const perPage = Math.min(Number(arg(args, "perPage") ?? 30) || 30, 100);
    const page = Math.max(Number(arg(args, "page") ?? 1) || 1, 1);
    const all = reposOwnedBy(ctx.gh, ctx.actor.id).sort((a, b) => a.id - b.id);
    const start = (page - 1) * perPage;
    const items = all.slice(start, start + perPage).map((r) => formatRepo(r, ctx.gh, ctx.baseUrl));
    return { structured: { total_count: all.length, repositories: items } };
  },

  get_repository(ctx, args) {
    const owner = requireString(args, "owner");
    const name = requireString(args, "name");
    const repo = ctx.gh.repos.findOneBy("full_name", `${owner}/${name}`);
    if (!repo) throw new ToolError(`Repository not found: ${owner}/${name}`);
    return { structured: formatRepo(repo, ctx.gh, ctx.baseUrl) };
  },

  list_issues(ctx, args) {
    const owner = requireString(args, "owner");
    const repoName = requireString(args, "repo");
    const repo = ctx.gh.repos.findOneBy("full_name", `${owner}/${repoName}`);
    if (!repo) throw new ToolError(`Repository not found: ${owner}/${repoName}`);
    const state = (arg<string>(args, "state") ?? "open").toLowerCase();
    const issues = ctx.gh.issues
      .findBy("repo_id", repo.id)
      .filter((i) => !i.is_pull_request)
      .filter((i) => (state === "all" ? true : i.state === state))
      .sort((a, b) => a.number - b.number)
      .map((i) => formatIssue(i, ctx.gh, ctx.baseUrl));
    return { structured: { total_count: issues.length, issues } };
  },

  create_issue(ctx, args) {
    const owner = requireString(args, "owner");
    const repoName = requireString(args, "repo");
    const title = requireString(args, "title");
    const body = arg<string>(args, "body");
    const repo = ctx.gh.repos.findOneBy("full_name", `${owner}/${repoName}`);
    if (!repo) throw new ToolError(`Repository not found: ${owner}/${repoName}`);
    if (!repo.has_issues) throw new ToolError(`Issues are disabled for ${owner}/${repoName}`);

    const number = nextIssueNumber(ctx.gh, repo.id);
    const row = ctx.gh.issues.insert({
      node_id: "",
      number,
      repo_id: repo.id,
      title: title.trim(),
      body: typeof body === "string" ? body : null,
      state: "open",
      state_reason: null,
      locked: false,
      active_lock_reason: null,
      user_id: ctx.actor.id,
      assignee_ids: [],
      label_ids: [],
      milestone_id: null,
      comments: 0,
      closed_at: null,
      closed_by_id: null,
      is_pull_request: false,
    } as Omit<GitHubIssue, "id" | "created_at" | "updated_at">);
    ctx.gh.issues.update(row.id, { node_id: nodeId("Issue", row.id) });
    ctx.gh.repos.update(repo.id, { open_issues_count: repo.open_issues_count + 1 });
    const issue = ctx.gh.issues.get(row.id)!;
    return { structured: formatIssue(issue, ctx.gh, ctx.baseUrl) };
  },

  search_repositories(ctx, args) {
    const query = requireString(args, "query").toLowerCase();
    const matches = ctx.gh.repos
      .all()
      .filter((r) => {
        const haystack = `${r.full_name} ${r.description ?? ""} ${(r.topics ?? []).join(" ")}`.toLowerCase();
        return haystack.includes(query);
      })
      .sort((a, b) => b.stargazers_count - a.stargazers_count || a.id - b.id)
      .map((r) => formatRepo(r, ctx.gh, ctx.baseUrl));
    return { structured: { total_count: matches.length, items: matches } };
  },
};

function nextIssueNumber(gh: GitHubStore, repoId: number): number {
  const issues = gh.issues.findBy("repo_id", repoId);
  const prs = gh.pullRequests.findBy("repo_id", repoId);
  const maxIssue = issues.reduce((m, i) => Math.max(m, i.number), 0);
  const maxPr = prs.reduce((m, p) => Math.max(m, p.number), 0);
  return Math.max(maxIssue, maxPr) + 1;
}

function nodeId(type: string, id: number): string {
  return Buffer.from(`0:${type}${id}`).toString("base64").replace(/=+$/, "");
}

export function callTool(
  store: Store,
  baseUrl: string,
  authUser: AuthUser,
  name: string,
  args: Record<string, unknown> | undefined,
): ToolResult {
  const handler = HANDLERS[name];
  if (!handler) throw new ToolError(`Unknown tool: ${name}`);
  const gh = getGitHubStore(store);
  const actor = gh.users.findOneBy("login", authUser.login);
  if (!actor) throw new ToolError(`Authenticated user not found in store: ${authUser.login}`);
  return handler({ store, gh, baseUrl, authUser, actor }, args);
}
