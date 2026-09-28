import { Store, type Collection } from "@emulators/core";
import type {
  PlanetScaleBranch,
  PlanetScaleDatabase,
  PlanetScaleOAuthClient,
  PlanetScaleOAuthGrant,
  PlanetScaleOAuthToken,
  PlanetScaleOrganization,
  PlanetScaleUser,
} from "./entities.js";

export interface PlanetScaleStore {
  users: Collection<PlanetScaleUser>;
  organizations: Collection<PlanetScaleOrganization>;
  databases: Collection<PlanetScaleDatabase>;
  branches: Collection<PlanetScaleBranch>;
  oauthClients: Collection<PlanetScaleOAuthClient>;
  oauthGrants: Collection<PlanetScaleOAuthGrant>;
  oauthTokens: Collection<PlanetScaleOAuthToken>;
}

// OAuth clients, codes, and tokens live in store collections (not the shared
// tokenMap) so they survive hosted Durable Object eviction like all other state.
export function getPlanetScaleStore(store: Store): PlanetScaleStore {
  return {
    users: store.collection<PlanetScaleUser>("planetscale.users", ["login"]),
    organizations: store.collection<PlanetScaleOrganization>("planetscale.organizations", ["name"]),
    databases: store.collection<PlanetScaleDatabase>("planetscale.databases", ["organization"]),
    branches: store.collection<PlanetScaleBranch>("planetscale.branches", ["database"]),
    oauthClients: store.collection<PlanetScaleOAuthClient>("planetscale.oauth_clients", ["client_id"]),
    oauthGrants: store.collection<PlanetScaleOAuthGrant>("planetscale.oauth_grants", ["code"]),
    oauthTokens: store.collection<PlanetScaleOAuthToken>("planetscale.oauth_tokens", ["access_token", "refresh_token"]),
  };
}
