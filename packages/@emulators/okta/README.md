# @emulators/okta

Metadata package for the Okta identity and management APIs emulator. The service implementation runs in the native Go engine distributed by the `emulate` npm package.

```bash
npm install emulate @emulators/okta
npx emulate --service okta
```

`@emulators/okta` remains importable for package discovery and compatibility, but it no longer contains a Node.js service implementation.
