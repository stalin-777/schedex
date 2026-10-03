# Development

[Back to README](../README.md) · [Manual publication](PUBLISHING.md)

## Requirements

Use Node.js `^22.22.2 || ^24.15.0 || >=26` with npm. Testing the extension also requires VS Code and the official Codex extension (`openai.chatgpt`).

## Commands

Run `make install`, then `make verify` to lint and check the source, run tests, and build an installable `schedex.vsix`.

| Task | Make | npm |
| --- | --- | --- |
| Install dependencies from the lockfile | `make install` | `npm ci` |
| Lint JavaScript | `make lint` | `npm run lint` |
| Check syntax, localization, and assets | `make check` | `npm run check` |
| Run tests | `make test` | `npm test` |
| Build the VSIX | `make vsix` | `npm run vsix` |
| Run all checks and build | `make verify` | Run lint, check, test, and vsix in that order |

The npm commands work on systems without Make. ESLint checks both extension code and webview scripts; `.editorconfig` defines whitespace and line endings.

## Debugging

Open the repository in VS Code and press **F5** with the **Run Schedex** configuration. This opens a separate Extension Development Host with the local code loaded. Install the official Codex extension in that host to test integration. Breakpoints in `src/` work without packaging or compilation.

## Icons

The Extensions list uses `media/schedex-logo.png`. Statusbar and Codex title buttons use `media/schedex-calendar-send.woff`, generated from `scripts/assets/schedex-calendar-send.svg`.

To edit the button glyph, change the SVG and run `python scripts/build-icon-font.py` with [FontTools](https://github.com/fonttools/fonttools) installed in your Python environment. Normal checks and VSIX builds use the committed WOFF and do not require Python.

## CI

The **Validate** workflow runs on pushes and pull requests. It installs dependencies, runs lint, source checks and tests, and builds a VSIX on Windows, macOS, and Linux.

The Linux job saves the universal VSIX as the **`schedex-vsix`** artifact. Download it from the workflow run's **Artifacts** section and unzip it to obtain `schedex.vsix`. Artifact storage follows the repository's configured retention period. For an archive of published versions, upload each tested VSIX to a GitHub Release as described in the [publication guide](PUBLISHING.md#github-releases).

## Codex integration

The current development environment is WSL, where prompt delivery has been manually verified. Other platforms use the matching Codex runtime bundled with the official extension; automated checks cover Windows, macOS, and Linux.

Schedex uses the `queue` command and app-server protocol from the runtime bundled with `openai.chatgpt`. Those interfaces can change with Codex updates. Test against the current official Codex extension before each Marketplace release.
