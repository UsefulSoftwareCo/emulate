import type { RouteContext } from "@emulators/core";

export function openapiRoutes({ app, baseUrl }: RouteContext): void {
  app.get("/openapi.json", (c) => c.json(buildSpec(baseUrl)));
}

const jsonResponse = (description: string) => ({
  description,
  content: { "application/json": { schema: { type: "object" } } },
});

function buildSpec(baseUrl: string): Record<string, unknown> {
  return {
    openapi: "3.0.3",
    info: {
      title: "Microsoft Graph REST API v1.0 (Emulated)",
      version: "1.0.0",
      description:
        "Emulated subset of Microsoft Graph v1.0. The OAuth security scheme uses the Microsoft Graph delegated scheme name and points at this emulator instance.",
    },
    servers: [{ url: baseUrl }],
    components: {
      securitySchemes: {
        azureAdDelegated: {
          type: "oauth2",
          description: "Microsoft identity platform delegated OAuth 2.0 authorization code flow.",
          flows: {
            authorizationCode: {
              authorizationUrl: `${baseUrl}/oauth2/v2.0/authorize`,
              tokenUrl: `${baseUrl}/oauth2/v2.0/token`,
              scopes: {
                openid: "Sign users in.",
                email: "View users' email address.",
                profile: "View users' basic profile.",
                offline_access: "Maintain access to data you have given it access to.",
                "User.Read": "Sign in and read user profile.",
              },
            },
          },
        },
      },
    },
    security: [{ azureAdDelegated: ["User.Read"] }],
    paths: {
      "/v1.0/me": {
        get: {
          operationId: "graphUser_GetMyProfile",
          summary: "Get the signed-in user",
          security: [{ azureAdDelegated: ["User.Read"] }],
          responses: {
            "200": jsonResponse("Graph user profile."),
            "401": jsonResponse("Authentication is required."),
          },
        },
      },
      "/v1.0/users/{id}": {
        get: {
          operationId: "graphUser_GetById",
          summary: "Get a user by id or user principal name",
          parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
          security: [{ azureAdDelegated: ["User.Read"] }],
          responses: {
            "200": jsonResponse("Graph user profile."),
            "401": jsonResponse("Authentication is required."),
            "404": jsonResponse("User not found."),
          },
        },
      },
    },
  };
}
