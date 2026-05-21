export const serviceName = "github";
export const serviceLabel = "GitHub REST, OAuth, and webhooks";
export const runtime = "native-go";

export interface CompatEntity {
  id: number;
  created_at: string;
  updated_at: string;
  [key: string]: unknown;
}

export type CompatInsertInput<T extends CompatEntity> = Omit<T, "id" | "created_at" | "updated_at"> & { id?: number };

export interface CompatQueryOptions<T> {
  filter?: (item: T) => boolean;
  sort?: (a: T, b: T) => number;
  page?: number;
  per_page?: number;
}

export interface CompatPaginatedResult<T> {
  items: T[];
  total_count: number;
  page: number;
  per_page: number;
  has_next: boolean;
  has_prev: boolean;
}

export interface CompatCollection<T extends CompatEntity = CompatEntity> {
  readonly fieldNames?: string[];
  insert(data: CompatInsertInput<T>): T;
  get(id: number): T | undefined;
  findBy(field: keyof T, value: T[keyof T] | string | number): T[];
  findOneBy(field: keyof T, value: T[keyof T] | string | number): T | undefined;
  update(id: number, data: Partial<T>): T | undefined;
  delete(id: number): boolean;
  all(): T[];
  query(options?: CompatQueryOptions<T>): CompatPaginatedResult<T>;
  count(filter?: (item: T) => boolean): number;
  clear(): void;
  snapshot(): unknown;
  restore(snapshot: unknown): void;
}

export interface CompatStoreSource {
  collection<T extends CompatEntity>(name: string, indexFields?: string[]): CompatCollection<T>;
}

export interface GitHubUser extends CompatEntity {
  [key: string]: unknown;
}
export interface GitHubOrg extends CompatEntity {
  [key: string]: unknown;
}
export interface GitHubTeam extends CompatEntity {
  [key: string]: unknown;
}
export interface GitHubTeamMember extends CompatEntity {
  [key: string]: unknown;
}
export interface GitHubTeamRepo extends CompatEntity {
  [key: string]: unknown;
}
export interface GitHubRepo extends CompatEntity {
  [key: string]: unknown;
}
export interface GitHubCollaborator extends CompatEntity {
  [key: string]: unknown;
}
export interface GitHubIssue extends CompatEntity {
  [key: string]: unknown;
}
export interface GitHubPullRequest extends CompatEntity {
  [key: string]: unknown;
}
export interface GitHubLabel extends CompatEntity {
  [key: string]: unknown;
}
export interface GitHubMilestone extends CompatEntity {
  [key: string]: unknown;
}
export interface GitHubComment extends CompatEntity {
  [key: string]: unknown;
}
export interface GitHubReview extends CompatEntity {
  [key: string]: unknown;
}
export interface GitHubIssueEvent extends CompatEntity {
  [key: string]: unknown;
}
export interface GitHubBranch extends CompatEntity {
  [key: string]: unknown;
}
export interface GitHubBranchProtection extends CompatEntity {
  [key: string]: unknown;
}
export interface GitHubRef extends CompatEntity {
  [key: string]: unknown;
}
export interface GitHubCommit extends CompatEntity {
  [key: string]: unknown;
}
export interface GitHubTree extends CompatEntity {
  [key: string]: unknown;
}
export interface GitHubBlob extends CompatEntity {
  [key: string]: unknown;
}
export interface GitHubTag extends CompatEntity {
  [key: string]: unknown;
}
export interface GitHubRelease extends CompatEntity {
  [key: string]: unknown;
}
export interface GitHubReleaseAsset extends CompatEntity {
  [key: string]: unknown;
}
export interface GitHubWebhook extends CompatEntity {
  [key: string]: unknown;
}
export interface GitHubWorkflow extends CompatEntity {
  [key: string]: unknown;
}
export interface GitHubWorkflowRun extends CompatEntity {
  [key: string]: unknown;
}
export interface GitHubJob extends CompatEntity {
  [key: string]: unknown;
}
export interface GitHubArtifact extends CompatEntity {
  [key: string]: unknown;
}
export interface GitHubSecret extends CompatEntity {
  [key: string]: unknown;
}
export interface GitHubCheckAnnotation {
  [key: string]: unknown;
}
export interface GitHubCheckRun extends CompatEntity {
  [key: string]: unknown;
}
export interface GitHubCheckSuite extends CompatEntity {
  [key: string]: unknown;
}
export interface GitHubOAuthApp extends CompatEntity {
  [key: string]: unknown;
}
export interface GitHubApp extends CompatEntity {
  [key: string]: unknown;
}
export interface GitHubAppInstallation extends CompatEntity {
  [key: string]: unknown;
}
export interface GitHubOAuthGrant extends CompatEntity {
  [key: string]: unknown;
}

export interface GitHubSeedConfig {
  [key: string]: unknown;
}

export interface GitHubStore {
  users: CompatCollection<GitHubUser>;
  orgs: CompatCollection<GitHubOrg>;
  teams: CompatCollection<GitHubTeam>;
  teamMembers: CompatCollection<GitHubTeamMember>;
  teamRepos: CompatCollection<GitHubTeamRepo>;
  repos: CompatCollection<GitHubRepo>;
  collaborators: CompatCollection<GitHubCollaborator>;
  issues: CompatCollection<GitHubIssue>;
  pullRequests: CompatCollection<GitHubPullRequest>;
  labels: CompatCollection<GitHubLabel>;
  milestones: CompatCollection<GitHubMilestone>;
  comments: CompatCollection<GitHubComment>;
  reviews: CompatCollection<GitHubReview>;
  issueEvents: CompatCollection<GitHubIssueEvent>;
  branches: CompatCollection<GitHubBranch>;
  branchProtections: CompatCollection<GitHubBranchProtection>;
  refs: CompatCollection<GitHubRef>;
  commits: CompatCollection<GitHubCommit>;
  trees: CompatCollection<GitHubTree>;
  blobs: CompatCollection<GitHubBlob>;
  tags: CompatCollection<GitHubTag>;
  releases: CompatCollection<GitHubRelease>;
  releaseAssets: CompatCollection<GitHubReleaseAsset>;
  webhooks: CompatCollection<GitHubWebhook>;
  workflows: CompatCollection<GitHubWorkflow>;
  workflowRuns: CompatCollection<GitHubWorkflowRun>;
  jobs: CompatCollection<GitHubJob>;
  artifacts: CompatCollection<GitHubArtifact>;
  secrets: CompatCollection<GitHubSecret>;
  checkRuns: CompatCollection<GitHubCheckRun>;
  checkSuites: CompatCollection<GitHubCheckSuite>;
  oauthApps: CompatCollection<GitHubOAuthApp>;
  apps: CompatCollection<GitHubApp>;
  appInstallations: CompatCollection<GitHubAppInstallation>;
  oauthGrants: CompatCollection<GitHubOAuthGrant>;
}

function compatCollection<T extends CompatEntity>(
  store: CompatStoreSource,
  name: string,
  indexFields: string[],
): CompatCollection<T> {
  return store.collection<T>(name, indexFields);
}

export function getGitHubStore(store: CompatStoreSource): GitHubStore {
  return {
    users: compatCollection<GitHubUser>(store, "github.users", ["login"]),
    orgs: compatCollection<GitHubOrg>(store, "github.orgs", ["login"]),
    teams: compatCollection<GitHubTeam>(store, "github.teams", ["org_id", "slug"]),
    teamMembers: compatCollection<GitHubTeamMember>(store, "github.team_members", ["team_id", "user_id"]),
    teamRepos: compatCollection<GitHubTeamRepo>(store, "github.team_repos", ["team_id", "repo_id"]),
    repos: compatCollection<GitHubRepo>(store, "github.repos", ["owner_id", "full_name"]),
    collaborators: compatCollection<GitHubCollaborator>(store, "github.collaborators", ["repo_id", "user_id"]),
    issues: compatCollection<GitHubIssue>(store, "github.issues", ["repo_id", "number"]),
    pullRequests: compatCollection<GitHubPullRequest>(store, "github.pull_requests", ["repo_id", "number"]),
    labels: compatCollection<GitHubLabel>(store, "github.labels", ["repo_id"]),
    milestones: compatCollection<GitHubMilestone>(store, "github.milestones", ["repo_id", "number"]),
    comments: compatCollection<GitHubComment>(store, "github.comments", ["repo_id"]),
    reviews: compatCollection<GitHubReview>(store, "github.reviews", ["repo_id", "pull_number"]),
    issueEvents: compatCollection<GitHubIssueEvent>(store, "github.issue_events", ["repo_id", "issue_number"]),
    branches: compatCollection<GitHubBranch>(store, "github.branches", ["repo_id"]),
    branchProtections: compatCollection<GitHubBranchProtection>(store, "github.branch_protections", ["repo_id"]),
    refs: compatCollection<GitHubRef>(store, "github.refs", ["repo_id"]),
    commits: compatCollection<GitHubCommit>(store, "github.commits", ["repo_id", "sha"]),
    trees: compatCollection<GitHubTree>(store, "github.trees", ["repo_id", "sha"]),
    blobs: compatCollection<GitHubBlob>(store, "github.blobs", ["repo_id", "sha"]),
    tags: compatCollection<GitHubTag>(store, "github.tags", ["repo_id"]),
    releases: compatCollection<GitHubRelease>(store, "github.releases", ["repo_id"]),
    releaseAssets: compatCollection<GitHubReleaseAsset>(store, "github.release_assets", ["release_id", "repo_id"]),
    webhooks: compatCollection<GitHubWebhook>(store, "github.webhooks", ["repo_id", "org_id"]),
    workflows: compatCollection<GitHubWorkflow>(store, "github.workflows", ["repo_id"]),
    workflowRuns: compatCollection<GitHubWorkflowRun>(store, "github.workflow_runs", ["repo_id", "workflow_id"]),
    jobs: compatCollection<GitHubJob>(store, "github.jobs", ["run_id"]),
    artifacts: compatCollection<GitHubArtifact>(store, "github.artifacts", ["run_id", "repo_id"]),
    secrets: compatCollection<GitHubSecret>(store, "github.secrets", ["repo_id", "org_id"]),
    checkRuns: compatCollection<GitHubCheckRun>(store, "github.check_runs", ["repo_id", "head_sha"]),
    checkSuites: compatCollection<GitHubCheckSuite>(store, "github.check_suites", ["repo_id", "head_sha"]),
    oauthApps: compatCollection<GitHubOAuthApp>(store, "github.oauth_apps", ["client_id"]),
    apps: compatCollection<GitHubApp>(store, "github.apps", ["slug"]),
    appInstallations: compatCollection<GitHubAppInstallation>(store, "github.app_installations", ["app_id", "installation_id"]),
    oauthGrants: compatCollection<GitHubOAuthGrant>(store, "github.oauth_grants", ["user_id", "client_id"]),
  };
}

export const service = {
  name: serviceName,
  label: serviceLabel,
  runtime,
} as const;

export const plugin = {
  ...service,
  register(): void {
    return undefined;
  },
  seed(): void {
    return undefined;
  },
} as const;

export const githubPlugin = plugin;

export function seedFromConfig(_store?: unknown, _baseUrl?: string, _config?: GitHubSeedConfig): void {
  return undefined;
}

export function createAppKeyResolver(): undefined {
  return undefined;
}

export default plugin;
