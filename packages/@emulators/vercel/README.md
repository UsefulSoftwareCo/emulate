# @emulators/vercel

Metadata package for the Vercel REST API emulator. The service implementation runs in the native Go engine distributed by the `emulate` npm package.

```bash
npm install emulate @emulators/vercel
npx emulate --service vercel
```

`@emulators/vercel` remains importable for package discovery and compatibility, but it no longer contains a Node.js service implementation.
