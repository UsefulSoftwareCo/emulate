# @emulators/apple

Metadata package for the Apple Sign In / OIDC emulator. The service implementation runs in the native Go engine distributed by the `emulate` npm package.

```bash
npm install emulate @emulators/apple
npx emulate --service apple
```

`@emulators/apple` remains importable for package discovery and compatibility, but it no longer contains a Node.js service implementation.
