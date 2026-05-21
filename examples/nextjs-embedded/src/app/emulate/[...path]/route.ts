import { createEmulateProxy } from "@emulators/adapter-next";

const target = process.env.EMULATE_URL ?? "http://127.0.0.1:4000";

export const { GET, HEAD, POST, PUT, PATCH, DELETE, OPTIONS } = createEmulateProxy({
  targets: {
    github: target,
    google: target,
  },
});
