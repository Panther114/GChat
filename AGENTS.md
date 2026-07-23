# GChat Engineering Guardrails

## Non-negotiable Railway load rule

The Railway deployment must never be subjected to large, continuous, or unbounded load.

- Keep every database query, message fetch, cache, socket map, timer, and broadcast bounded.
- Do not add client polling or recurring server jobs without measured need and a documented load budget.
- Keep pagination capped, add indexes for new query paths, and avoid N+1 queries.
- Scope socket and push fan-out to the smallest authorized audience.
- Run load tests only against local or disposable test environments, never Railway production.
- Production migrations must be explicit, transactional, backed up, and must not re-encrypt history or perform sustained background work.
- Any change affecting request frequency, query shape, message rendering, socket fan-out, or background work requires a before/after measurement.

## Repository workflow

- Preserve the `main` and `Increment-A` branch history; do not commit, push, deploy, or run destructive production migrations unless explicitly requested.
- For implementation requests, commit validated changes and push them directly to `origin/main` once complete, unless the user explicitly says not to push.
- Add focused regression tests before security fixes or behavior-preserving refactors.
- Treat `public/app.js`, `public/style.css`, and generated bundles as build outputs once the modular source pipeline is active; edit their source modules instead.

## UI dialogs and prompts

- Never use the browser-native `window.prompt`, `window.confirm`, or `window.alert` for product UI.
- Always use in-app custom modals/popups that match the GChat theme (same modal overlay pattern as Create Group / Join Group).
- Channels are separate sub-chats: each channel only shows its own messages; untagged legacy traffic belongs to `#main`.
- Every message (text and attachments) must be stamped with the active channel; channel is part of encrypted metadata and client-side filter identity.

## Motion and transitions

- Ship smooth hover, focus, press, theme, and panel transitions on interactive UI.
- Do **not** disable animations under `prefers-reduced-motion`. Product motion must still run in that mode (GChat intentionally keeps motion for a high-tech feel).
- Prefer `transform` / `opacity` / `color` / `border-color` / `background-color` transitions (150–280ms) with an ease-out curve.
- Theme switches must cross-fade surface colors via CSS transitions on `html` / `body` / chrome tokens.
