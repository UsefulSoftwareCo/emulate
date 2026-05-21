# @emulators/github

Metadata package for the GitHub REST, OAuth, and webhooks emulator. The service implementation runs in the native Go engine distributed by the `emulate` npm package.

```bash
npm install emulate @emulators/github
npx emulate --service github
```

`@emulators/github` remains importable for package discovery and compatibility, but it no longer contains a Node.js service implementation.
