export type Provider = {
  name: string;
  slug: string;
  authorizeUrl: string;
  tokenUrl: string;
  userInfoUrl: string;
  clientId: string;
  clientSecret: string;
  scope: string;
  tokenFieldName?: string;
  userNameField: string;
  userEmailField: string;
  userLoginField?: string;
  userAvatarField?: string;
  tokenRequestContentType?: string;
  tokenResponseAccessTokenField?: string;
};

const GITHUB_URL = process.env.GITHUB_EMULATOR_URL ?? "http://localhost:4001";
const VERCEL_URL = process.env.VERCEL_EMULATOR_URL ?? "http://localhost:4000";
const GOOGLE_URL = process.env.GOOGLE_EMULATOR_URL ?? "http://localhost:4002";
const APP_URL = process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000";

export const providers: Record<string, Provider> = {
  github: {
    name: "GitHub",
    slug: "github",
    authorizeUrl: `${GITHUB_URL}/login/oauth/authorize`,
    tokenUrl: `${GITHUB_URL}/login/oauth/access_token`,
    userInfoUrl: `${GITHUB_URL}/user`,
    clientId: process.env.GITHUB_CLIENT_ID ?? "emu_github_client_id",
    clientSecret: process.env.GITHUB_CLIENT_SECRET ?? "emu_github_client_secret",
    scope: "user repo",
    userNameField: "name",
    userEmailField: "email",
    userLoginField: "login",
    userAvatarField: "avatar_url",
  },
  vercel: {
    name: "Vercel",
    slug: "vercel",
    authorizeUrl: `${VERCEL_URL}/oauth/authorize`,
    tokenUrl: `${VERCEL_URL}/login/oauth/token`,
    userInfoUrl: `${VERCEL_URL}/login/oauth/userinfo`,
    clientId: process.env.VERCEL_CLIENT_ID ?? "emu_vercel_client_id",
    clientSecret: process.env.VERCEL_CLIENT_SECRET ?? "emu_vercel_client_secret",
    scope: "",
    userNameField: "name",
    userEmailField: "email",
    userLoginField: "preferred_username",
    userAvatarField: "picture",
  },
  google: {
    name: "Google",
    slug: "google",
    authorizeUrl: `${GOOGLE_URL}/o/oauth2/v2/auth`,
    tokenUrl: `${GOOGLE_URL}/oauth2/token`,
    userInfoUrl: `${GOOGLE_URL}/oauth2/v2/userinfo`,
    clientId: process.env.GOOGLE_CLIENT_ID ?? "emu_google_client_id",
    clientSecret: process.env.GOOGLE_CLIENT_SECRET ?? "emu_google_client_secret",
    scope: "openid email profile",
    tokenRequestContentType: "application/x-www-form-urlencoded",
    userNameField: "name",
    userEmailField: "email",
    userAvatarField: "picture",
  },
};

export function getCallbackUrl(provider: string): string {
  return `${APP_URL}/api/auth/callback/${provider}`;
}
