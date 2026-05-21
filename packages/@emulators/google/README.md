# @emulators/google

Metadata package for the Google OAuth, Gmail, Calendar, and Drive emulator. The service implementation runs in the native Go engine distributed by the `emulate` npm package.

```bash
npm install emulate @emulators/google
npx emulate --service google
```

`@emulators/google` remains importable for package discovery and compatibility, but it no longer contains a Node.js service implementation.
