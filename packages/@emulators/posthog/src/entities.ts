import type { Entity } from "@emulators/core";

export interface PostHogUser extends Entity {
  uuid: string;
  email: string;
  name: string;
}

export interface PostHogProject extends Entity {
  project_id: number;
  name: string;
  api_token: string;
}

export interface PostHogEvent extends Entity {
  project_id: number;
  event: string;
  distinct_id: string;
  properties: Record<string, unknown>;
  timestamp: string;
}

export interface OAuthClientMetadata {
  client_id: string;
  client_name?: string;
  redirect_uris: string[];
  token_endpoint_auth_method?: string;
  grant_types?: string[];
  response_types?: string[];
}

export interface RegisteredOAuthClient extends Entity {
  client_id: string;
  client_secret: string | null;
  client_name: string;
  redirect_uris: string[];
  token_endpoint_auth_method: string;
}

export interface PendingOAuthCode {
  user_uuid: string;
  login: string;
  scope: string;
  redirect_uri: string;
  client_id: string;
  code_challenge: string | null;
  code_challenge_method: string | null;
  created_at: number;
}
