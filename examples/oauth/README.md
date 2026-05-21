# OAuth Example

A Next.js app demonstrating OAuth sign-in with all three emulated providers: **GitHub**, **Google**, and **Vercel**.

No real accounts or API keys needed — everything runs against the local emulator.

## Setup

```bash
# From the repo root, install dependencies
pnpm install

# Start the emulator with the example config
cd examples/oauth
npx emulate --seed emulate.config.yaml

# In a separate terminal, start the Next.js app
cd examples/oauth
pnpm dev
```

Open [http://localhost:3000](http://localhost:3000) and click any provider to sign in.

## How It Works

1. Clicking a provider button redirects to `/api/auth/[provider]`, which builds the OAuth authorize URL and redirects the browser to the emulator.
2. The emulator shows a user-picker page. Select a seeded user.
3. The emulator redirects back to `/api/auth/callback/[provider]` with an authorization code.
4. The callback route exchanges the code for an access token, fetches user info, and stores the session in an HTTP-only cookie.
5. The dashboard displays the authenticated user's profile and access token.

## Configuration

The `emulate.config.yaml` seeds users and OAuth apps for all three providers. By default, the Next.js app sends GitHub, Google, and Vercel OAuth traffic to `http://localhost:4000`, matching `npx emulate --seed emulate.config.yaml`. If you override the provider URLs with environment variables, point all three at the same server unless you start separate emulator processes.

See the root [README](../../README.md) for full emulator configuration options.
