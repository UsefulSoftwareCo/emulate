# @emulators/clerk

Metadata package for the Clerk authentication and user management emulator. The service implementation runs in the native Go engine distributed by the `emulate` npm package.

```bash
npm install emulate @emulators/clerk
npx emulate --service clerk
```

`@emulators/clerk` remains importable for package discovery and compatibility, but it no longer contains a Node.js service implementation.
