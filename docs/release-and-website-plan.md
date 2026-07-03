# todo.md release and website plan

todo.md is a local-first Markdown task board. Releases should make that plain: the app is small, the files are yours, and GitHub is only where we publish binaries and the project website.

## Goals

- Build versioned desktop binaries in GitHub Actions.
- Store public downloads as GitHub Release assets.
- Keep release creation repeatable from a tag.
- Publish a simple GitHub Pages site with a hero section, download entry point, and mascot.
- Preserve the app name as `todo.md` everywhere user-facing unless a filename or package identifier requires a safer variant such as `todo-md`.

## Current state

- The app is a Tauri 2 desktop app.
- `package.json`, `src-tauri/tauri.conf.json`, and `src-tauri/Cargo.toml` are all versioned at `0.1.0`.
- The lockfiles also record project package versions: `package-lock.json` for npm and `src-tauri/Cargo.lock` for Cargo.
- CI already runs frontend type-checks/tests/builds, Rust formatting/linting/tests/coverage, security checks, and a macOS Tauri bundle build.
- The current Tauri bundle target is `["app"]`, which is useful for validating a macOS build but is not the best public download format.
- There is no release workflow, no Pages workflow, and no website source directory yet.

## Release model

Use SemVer tags:

- Stable release tags: `vMAJOR.MINOR.PATCH`, for example `v0.2.0`.
- Release candidates: `vMAJOR.MINOR.PATCH-rc.N`, for example `v0.2.0-rc.1`.
- GitHub Release titles: `todo.md v0.2.0`.
- Draft releases stay draft until a human downloads and smoke-tests the generated assets.

Keep these versions in sync for every release:

- `package.json` `version`
- `package-lock.json` root and package versions
- `src-tauri/tauri.conf.json` `version`
- `src-tauri/Cargo.toml` `version`
- `src-tauri/Cargo.lock` package entry for `todo-md`

Add a small future helper script, `scripts/set-version.mjs`, that accepts a version without the leading `v`, updates those files, and fails if the working tree is dirty. That keeps release PRs boring and reviewable. The script should refresh `package-lock.json` with `npm install --package-lock-only`, update the `todo-md` package entry in `src-tauri/Cargo.lock`, and then verify the result with `cargo metadata --manifest-path src-tauri/Cargo.toml --locked` so CI's `npm ci` and Cargo `--locked` checks agree with the release PR.

## Public artifacts

Phase 1 should release macOS binaries because the existing CI already proves that path.

Recommended first release assets:

- `todo-md_[version]_macos_aarch64.dmg`
- `todo-md_[version]_macos_x64.dmg`

Keep the `.app` bundle as a short-lived workflow artifact if it is useful for debugging, but do not make the raw `.app` directory the primary public download. A `.dmg` is easier for users to install and easier to attach as one versioned file.

If a future Tauri/macOS setup produces one universal `.dmg`, prefer that for the primary download. If the release keeps separate Apple Silicon and Intel assets, the website should show explicit architecture choices instead of guessing.

Phase 2 can add:

- Windows: `todo-md_[version]_windows_x64-setup.exe` through the Tauri NSIS bundle.
- Linux: `todo-md_[version]_linux_x64.AppImage` and optionally `todo-md_[version]_linux_x64.deb`.

When Windows and Linux are added, the website download chooser should prefer the user's detected platform but always expose all downloads through the GitHub Release page.

## Release workflow

Add `.github/workflows/release.yml` in a follow-up implementation ticket.

Trigger it from:

- `push` tags matching `v*.*.*`
- `workflow_dispatch` with a required `tag` input for manual retries and release-candidate rebuilds

Manual dispatch must never infer the release tag from `main`. It should require a tag such as `v0.2.0` or `v0.2.0-rc.1`, validate that the tag exists, check out that tag, and use that same value for `tagName`, `releaseName`, and prerelease detection.

Use a matrix with `fail-fast: false` so one platform failure does not hide the others. The initial matrix can be:

- `macos-14`, `aarch64-apple-darwin`
- `macos-14`, `x86_64-apple-darwin`

The workflow should:

1. Check out the tag.
2. Set up Node.js 22 with npm cache.
3. Install Rust stable with the required macOS targets.
4. Run `npm ci`.
5. Run the existing checks that are cheap and release-relevant: `npm run typecheck` and `npm run test:frontend`.
6. Build with `tauri-apps/tauri-action@v1`.
7. Create or update a draft GitHub Release for the tag.
8. Upload versioned installer assets using a predictable `releaseAssetNamePattern`.

Required workflow permissions:

```yaml
permissions:
  contents: write
```

The Tauri action uses `GITHUB_TOKEN` to create or update releases. If GitHub returns a write-permission error, enable read/write workflow permissions in repository settings.

Example Tauri action shape:

```yaml
- name: Resolve release tag
  run: echo "RELEASE_TAG=${{ github.event_name == 'workflow_dispatch' && inputs.tag || github.ref_name }}" >> "$GITHUB_ENV"

- uses: tauri-apps/tauri-action@v1
  env:
    GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
  with:
    tagName: ${{ env.RELEASE_TAG }}
    releaseName: todo.md ${{ env.RELEASE_TAG }}
    releaseDraft: true
    prerelease: ${{ contains(env.RELEASE_TAG, '-rc.') }}
    generateReleaseNotes: true
    releaseAssetNamePattern: todo-md_[version]_[platform]_[arch][setup][ext]
    args: ${{ matrix.args }}
```

Update `src-tauri/tauri.conf.json` before enabling this workflow:

- Phase 1: keep `app` for the existing CI bundle artifact and add `dmg` for public release builds, or update the existing CI artifact path at the same time.
- Phase 2: add `nsis`, `appimage`, and `deb` when those platforms are ready.

## Signing and notarization

Do not block the first internal draft release on code signing. Do block a public macOS announcement on a signing decision.

Recommended path:

- First draft release: unsigned macOS `.dmg`, linked only from GitHub Releases for internal testing.
- First public release: Developer ID signed and notarized macOS `.dmg`.
- Later: Windows code signing before promoting Windows downloads as the default.

Store signing material only in GitHub Actions secrets. The release workflow should be written so unsigned builds still work on forks and pull requests, while signed builds only run for trusted tag builds in the main repository.

## Human release procedure

1. Merge all release-bound changes into `main`.
2. Run the version helper in a release PR, for example `node scripts/set-version.mjs 0.2.0`.
3. Merge the version PR after CI passes.
4. Tag the merge commit: `git tag v0.2.0 && git push origin v0.2.0`.
5. Wait for the release workflow.
6. Download and smoke-test each asset.
7. Edit the draft release notes if needed.
8. Publish the GitHub Release.
9. Confirm the website download button points to the new latest release.

Smoke test checklist:

- The app launches.
- A new project can be created.
- An existing folder can be added as a project.
- A ticket can be created, edited, moved between statuses, and reopened after relaunch.
- Pasted images still render from local task files.
- The app does not require any network access for normal task usage.

## GitHub Pages website

Add a dedicated `site/` directory in a follow-up implementation ticket. Keep it separate from the Tauri app frontend so release-site changes cannot accidentally affect the desktop app.

Recommended structure:

```text
site/
  index.html
  styles.css
  downloads.js
  assets/
    mascot.png
    mascot@2x.png
    icon.svg
```

Use a static site with no framework at first. The page is simple enough that a build step is optional, and avoiding a second frontend stack keeps maintenance low.

Primary sections:

- Hero: app name, short description, mascot, download button.
- How it stores data: projects are folders, tickets are Markdown files in `.tasks`.
- Agent-friendly workflow: frontmatter keeps status, priority, size, assignee, and PR links readable.
- Downloads: latest release, all releases, and platform-specific links when available.
- Small footer: GitHub repository, license, release notes.

Hero copy direction:

- Headline: `todo.md`
- Supporting line: `A local task board that keeps every ticket as a Markdown file.`
- Detail line: `Use folders you own. Let agents read plain files. No account, no service, no hidden database.`
- Primary button: `Download latest`
- Secondary link: `View on GitHub`

Avoid inflated claims like "revolutionary", "AI-powered productivity", or "the future of tasks". The tone should be direct and a little warm.

## Download button behavior

Start with the most reliable version:

- Primary hero button links to `https://github.com/<owner>/<repo>/releases/latest`.
- Secondary download list links to the latest release page until stable asset names and platforms are finalized.

Then improve it:

- `downloads.js` fetches the latest GitHub Release metadata.
- It detects macOS, Windows, or Linux from `navigator.userAgentData` with a `navigator.platform` fallback.
- It selects a direct asset only when the match is unambiguous.
- For macOS releases with separate Apple Silicon and Intel `.dmg` files, it shows both architecture buttons and keeps the primary button pointed at the latest release page.
- If detection or the GitHub API fails, it falls back to the latest release page.

The app's local-first promise is about task data. The website may use GitHub's public releases API to find binaries because downloads are hosted by GitHub anyway.

## Pages workflow

Add `.github/workflows/pages.yml` in a follow-up implementation ticket.

Trigger it from:

- Pushes to `main` that touch `site/**` or the Pages workflow.
- `workflow_dispatch`.

Use GitHub Pages' custom workflow path:

```yaml
permissions:
  contents: read
  pages: write
  id-token: write
```

Workflow shape:

1. Check out the repository.
2. Configure Pages.
3. Copy or build `site/` into a publish directory.
4. Upload the directory with `actions/upload-pages-artifact`.
5. Deploy with `actions/deploy-pages` to the `github-pages` environment.

If the site stays plain HTML/CSS/JS, the publish directory can be `site/` directly. If it later gains bundling, add `npm run build:site` and publish `site/dist`.

## Visual direction

Style: vintage, colorful, simple, and fun.

Palette:

- Paper: `#fff4d8`
- Ink: `#243047`
- Tomato: `#e9543f`
- Bun: `#e6a93d`
- Pickle green: `#4f9b69`
- Sky: `#74b9d9`

Typography:

- Use a sturdy system serif for the hero if no webfont is added.
- Use a readable system sans for body text and buttons.
- Keep letter spacing normal.

Layout:

- The first viewport should show the `todo.md` name, mascot, and download button immediately.
- Keep the hero full-bleed with a flat paper background, not a dark gradient.
- Use simple borders, offset color blocks, and small badge-like labels sparingly.
- Keep the next section peeking below the hero on desktop and mobile.

## Mascot

Mascot concept: a small golden hamster eating a kajzerka.

Art direction:

- Round hamster, alert eyes, tiny paws holding a five-scored kajzerka.
- The bun should read as a Polish kajzerka, not a generic burger bun.
- Use visible crumbs and a simple happy posture, but avoid a meme face.
- Thick ink outline, flat colors, light paper texture.
- Works as a hero illustration, app-site favicon detail, and small release-note sticker.

Suggested asset set:

- `site/assets/mascot.png` at 1x and 2x.
- `site/assets/mascot-transparent.png` for release notes and social previews.
- `site/assets/mascot.svg` only if the final art is simple enough to maintain as vector.

Prompt for a future image-generation pass:

```text
A friendly golden hamster holding and eating a round Polish kajzerka bread roll with five curved score marks, small crumbs, vintage children's book illustration style, warm paper texture, flat tomato red and sky blue accents, thick dark ink outline, simple cheerful expression, centered full-body mascot, transparent background
```

## Follow-up implementation tickets

1. Add `scripts/set-version.mjs` and tests for synchronized app versions.
2. Change release bundle targets and add the tag-triggered release workflow.
3. Decide and implement macOS signing and notarization.
4. Add the static `site/` source with the hero, download area, and mascot assets.
5. Add the GitHub Pages deployment workflow.
6. Add website download detection once release asset names are stable.

## References

- Tauri GitHub Action: https://github.com/tauri-apps/tauri-action
- Tauri GitHub Actions distribution guide: https://v2.tauri.app/distribute/pipelines/github/
- GitHub Pages custom workflow guide: https://docs.github.com/en/pages/getting-started-with-github-pages/using-custom-workflows-with-github-pages
- GitHub Pages deploy action: https://github.com/actions/deploy-pages
