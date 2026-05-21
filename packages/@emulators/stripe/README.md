# @emulators/stripe

Metadata package for the Stripe billing and payments API emulator. The service implementation runs in the native Go engine distributed by the `emulate` npm package.

```bash
npm install emulate @emulators/stripe
npx emulate --service stripe
```

`@emulators/stripe` remains importable for package discovery and compatibility, but it no longer contains a Node.js service implementation.
