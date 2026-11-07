# QueryMint SDK npm release checklist

The SDK and shared package are configured for public npm distribution at version `0.1.0`, but have not been published. This document does not run publication or require credentials.

## Before release

- Confirm the publisher account controls the `@querymint` npm scope and is authorized to publish both package names.
- Check that `@querymint/shared@0.1.0` and `@querymint/sdk@0.1.0` are available and that their versions have not already been published. Do not overwrite or reuse an existing version.
- Review `packages/shared/package.json` and `packages/sdk/package.json`: descriptions, MIT license, ESM entry, declaration entry, `files`, runtime dependencies, `engines`, and public access setting.
- Keep the SDK dependency on the shared package version aligned. For a later release, bump shared first, update the SDK dependency, regenerate `package-lock.json`, and rerun the external-consumer test.
- Confirm the packages contain no private keys, Arkiv access keys, encryption secrets, local environment files, or application data.

## Reproducible local validation

Run these commands from the repository root:

```powershell
npm ci
npm run build --workspace @querymint/shared
npm test --workspace @querymint/sdk
npm run build --workspace @querymint/sdk
npm pack --dry-run --workspace @querymint/shared
npm pack --dry-run --workspace @querymint/sdk
powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts/validate-sdk-consumer.ps1
```

The consumer script packs both libraries, installs the tarballs and Vite/React dependencies into a newly created OS temporary directory outside the monorepo, builds the independent Vite app, then calls `quote()` against the configured coordinator. It uses a public test buyer address and has no wallet transaction methods. It never calls `pay()` or `deliver()`. The quote request creates only coordinator-side ephemeral quote state; it does not approve tokens or submit a blockchain transaction. The script leaves the temporary consumer directory available for inspection.

The repository `.npmrc` sets `ignore-scripts=true`, so release preparation explicitly builds and tests before packing or publishing. The package scripts themselves include dependency builds; npm lifecycle pre/post hooks are not relied on to create artifacts.

## Publish (operator action only)

After all checks pass, authenticate using the operator’s approved local npm workflow. Do not put npm tokens in source, `.env`, CI logs, or this repository. Publish shared first because it is a runtime dependency of the SDK:

```powershell
npm publish --workspace @querymint/shared --access public
npm view @querymint/shared@0.1.0 version
npm publish --workspace @querymint/sdk --access public
npm view @querymint/sdk@0.1.0 version
```

No `npm publish` command has been run. Do not publish until the scope/name checks, package contents, independent consumer test, and release approval are complete.

## After publication

- Create a clean Vite/React application outside the monorepo and run `npm install @querymint/sdk@0.1.0 viem wagmi @tanstack/react-query`.
- Follow [the SDK integration guide](../packages/sdk/README.md), using only public Vite variables.
- Verify quote generation and review output with a test buyer. Do not approve, settle, or deliver data without separate explicit authorization.
- Record the published versions, npm package links, validation commit, and known constraints in release notes. Never claim the package was published until npm metadata confirms it.
