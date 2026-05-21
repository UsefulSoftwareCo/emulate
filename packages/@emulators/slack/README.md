# @emulators/slack

Metadata package for the Slack Web API, OAuth, and webhooks emulator. The service implementation runs in the native Go engine distributed by the `emulate` npm package.

```bash
npm install emulate @emulators/slack
npx emulate --service slack
```

`@emulators/slack` remains importable for package discovery and compatibility, but it no longer contains a Node.js service implementation.
