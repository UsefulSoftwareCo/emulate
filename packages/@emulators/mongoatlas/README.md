# @emulators/mongoatlas

Metadata package for the MongoDB Atlas Admin API and Data API emulator. The service implementation runs in the native Go engine distributed by the `emulate` npm package.

```bash
npm install emulate @emulators/mongoatlas
npx emulate --service mongoatlas
```

`@emulators/mongoatlas` remains importable for package discovery and compatibility, but it no longer contains a Node.js service implementation.
