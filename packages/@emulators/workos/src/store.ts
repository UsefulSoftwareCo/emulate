import { Store, type Collection } from "@emulators/core";

import type {
  WorkosApiKey,
  WorkosAuthCode,
  WorkosInvitation,
  WorkosMembership,
  WorkosOAuthClient,
  WorkosOAuthCode,
  WorkosOAuthSettings,
  WorkosOrganization,
  WorkosOrganizationDomain,
  WorkosSession,
  WorkosUser,
  WorkosVaultObject,
} from "./entities.js";

export interface WorkosStore {
  users: Collection<WorkosUser>;
  organizations: Collection<WorkosOrganization>;
  organizationDomains: Collection<WorkosOrganizationDomain>;
  memberships: Collection<WorkosMembership>;
  invitations: Collection<WorkosInvitation>;
  apiKeys: Collection<WorkosApiKey>;
  authCodes: Collection<WorkosAuthCode>;
  sessions: Collection<WorkosSession>;
  vaultObjects: Collection<WorkosVaultObject>;
  oauthClients: Collection<WorkosOAuthClient>;
  oauthCodes: Collection<WorkosOAuthCode>;
  oauthSettings: Collection<WorkosOAuthSettings>;
}

export function getWorkosStore(store: Store): WorkosStore {
  return {
    users: store.collection<WorkosUser>("workos.users", ["workos_id", "email"]),
    organizations: store.collection<WorkosOrganization>("workos.organizations", ["workos_id"]),
    organizationDomains: store.collection<WorkosOrganizationDomain>("workos.organization_domains", [
      "workos_id",
      "organization_id",
      "domain",
    ]),
    memberships: store.collection<WorkosMembership>("workos.memberships", ["workos_id", "user_id", "organization_id"]),
    invitations: store.collection<WorkosInvitation>("workos.invitations", [
      "workos_id",
      "email",
      "organization_id",
      "token",
    ]),
    apiKeys: store.collection<WorkosApiKey>("workos.api_keys", ["workos_id", "value", "user_id"]),
    authCodes: store.collection<WorkosAuthCode>("workos.auth_codes", ["code"]),
    sessions: store.collection<WorkosSession>("workos.sessions", ["refresh_token", "workos_id"]),
    vaultObjects: store.collection<WorkosVaultObject>("workos.vault_objects", ["workos_id", "name"]),
    oauthClients: store.collection<WorkosOAuthClient>("workos.oauth_clients", ["client_id"]),
    oauthCodes: store.collection<WorkosOAuthCode>("workos.oauth_codes", ["code"]),
    oauthSettings: store.collection<WorkosOAuthSettings>("workos.oauth_settings", []),
  };
}
