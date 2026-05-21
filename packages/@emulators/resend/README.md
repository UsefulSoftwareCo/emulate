# @emulators/resend

Metadata package for the Resend email API emulator. The service implementation runs in the native Go engine distributed by the `emulate` npm package.

```bash
npm install emulate @emulators/resend
npx emulate --service resend
```

`@emulators/resend` remains importable for package discovery and compatibility, but it no longer contains a Node.js service implementation.
