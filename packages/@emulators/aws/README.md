# @emulators/aws

Metadata package for the AWS cloud services emulator. The service implementation runs in the native Go engine distributed by the `emulate` npm package.

```bash
npm install emulate @emulators/aws
npx emulate --service aws
```

`@emulators/aws` remains importable for package discovery and compatibility, but it no longer contains a Node.js service implementation.
