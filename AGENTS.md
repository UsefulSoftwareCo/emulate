# Agent policy

Read [PRODUCT.md](PRODUCT.md) before changing service capabilities, protocols,
control-plane behavior, or hosted emulator UX. Release preparation follows
[RELEASING.md](RELEASING.md).

## Tooling

- Use `pnpm` for repository package commands. End-user installation examples
  use npm because it is the universal interface.
- In user-facing CLI examples, invoke the package as `npx emulate`; `emulate`
  is a zsh shell built-in. It may appear bare only when another process resolves
  it as a subprocess executable.
- When adding a dependency, verify and install the current npm release with
  `pnpm add <package>` or `npm view <package> version`.
- Do not use emojis. Avoid dash punctuation in prose; rephrase with commas,
  parentheses, or separate sentences. Double hyphens are reserved for CLI
  flags.

## Emulator UI

Build every emulator page with the shared design system in
`packages/@emulators/core/src/ui.ts`. Use the existing render functions and CSS
classes; never add package-local HTML documents or custom `<style>` blocks.

Available page primitives include `renderCardPage`, `renderErrorPage`,
`renderSettingsPage`, `renderInspectorPage`, `renderFormPostPage`, and
`renderUserButton`. Add a reusable primitive to core when these cannot express
a legitimate new page type.

## Documentation and releases

When commands, flags, routes, seed configuration, SDK integration, or user
behavior changes, update the relevant surfaces together: `README.md`, service
skills, `apps/web/`, and CLI help.

Never merge a release or any other change without explicit maintainer approval
for that merge. Preparing a branch and PR is allowed; publishing remains a
maintainer-controlled action.
