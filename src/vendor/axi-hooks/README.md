# AXI session hooks snapshot

Source: https://github.com/kunchenguid/axi/tree/main/packages/axi-sdk-js
Package: `axi-sdk-js@0.1.12`, published `dist/hooks.js` and `dist/hooks.d.ts`.
License: MIT; retained verbatim in LICENSE.

This isolated module uses only Node built-ins. It preserves the existing hook
installation/status/removal behavior without pulling in the SDK output renderer.
The implementation and declarations are unmodified. Keep the original managed
OpenCode marker so already installed integrations remain recognizable.
Updates are deliberate: compare upstream, preserve the license, and run setup tests
against temporary homes. Never install hooks on the user's machine as a build step.

SHA-256 of the copied files:
- `hooks.js`: `b200af66e7fdfb02bd04c4d5b4914c84bd0d54e5cef754267c7d08c5c351f4ec`
- `hooks.d.ts`: `3d5ae79f62a89f26cbd3668e20d0a42ac7f7a71f49b1081feb8b2610164188a6`
