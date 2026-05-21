# @emulators/microsoft

Metadata package for the Microsoft Entra ID and Graph emulator. The service implementation runs in the native Go engine distributed by the `emulate` npm package.

```bash
npm install emulate @emulators/microsoft
npx emulate --service microsoft
```

`@emulators/microsoft` remains importable for package discovery and compatibility, but it no longer contains a Node.js service implementation.
