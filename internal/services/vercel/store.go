package vercel

import corestore "github.com/vercel-labs/emulate/internal/core/store"

type Store struct {
	Users              *corestore.Collection
	Teams              *corestore.Collection
	TeamMembers        *corestore.Collection
	Projects           *corestore.Collection
	Deployments        *corestore.Collection
	DeploymentAliases  *corestore.Collection
	Builds             *corestore.Collection
	DeploymentEvents   *corestore.Collection
	Files              *corestore.Collection
	DeploymentFiles    *corestore.Collection
	Domains            *corestore.Collection
	EnvVars            *corestore.Collection
	ProtectionBypasses *corestore.Collection
	APIKeys            *corestore.Collection
	Integrations       *corestore.Collection
	OAuthCodes         *corestore.Collection
	OAuthTokens        *corestore.Collection
}

func NewStore(runtimeStore *corestore.Store) Store {
	return Store{
		Users:              runtimeStore.MustCollection("vercel.users", "uid", "username", "email"),
		Teams:              runtimeStore.MustCollection("vercel.teams", "uid", "slug"),
		TeamMembers:        runtimeStore.MustCollection("vercel.team_members", "teamId", "userId"),
		Projects:           runtimeStore.MustCollection("vercel.projects", "uid", "name", "accountId"),
		Deployments:        runtimeStore.MustCollection("vercel.deployments", "uid", "url", "projectId"),
		DeploymentAliases:  runtimeStore.MustCollection("vercel.deployment_aliases", "uid", "alias", "deploymentId", "projectId"),
		Builds:             runtimeStore.MustCollection("vercel.builds", "uid", "deploymentId"),
		DeploymentEvents:   runtimeStore.MustCollection("vercel.deployment_events", "deploymentId"),
		Files:              runtimeStore.MustCollection("vercel.files", "digest"),
		DeploymentFiles:    runtimeStore.MustCollection("vercel.deployment_files", "uid", "deploymentId"),
		Domains:            runtimeStore.MustCollection("vercel.domains", "uid", "projectId", "name"),
		EnvVars:            runtimeStore.MustCollection("vercel.env_vars", "uid", "projectId", "key"),
		ProtectionBypasses: runtimeStore.MustCollection("vercel.protection_bypasses", "projectId", "secret"),
		APIKeys:            runtimeStore.MustCollection("vercel.api_keys", "uid", "userId", "teamId", "tokenString"),
		Integrations:       runtimeStore.MustCollection("vercel.integrations", "client_id"),
		OAuthCodes:         runtimeStore.MustCollection("vercel.oauth_codes", "code", "username"),
		OAuthTokens:        runtimeStore.MustCollection("vercel.oauth_tokens", "tokenString", "username"),
	}
}
