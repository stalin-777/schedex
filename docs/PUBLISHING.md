# Manual publication

[Back to README](../README.md) · [Development](DEVELOPMENT.md)

## Prepare the VSIX

The release version is set in `package.json` and `package-lock.json`. For later releases, increment the version in both files, for example:

```sh
npm version patch --no-git-tag-version
```

Run `make verify` to check the project and build `schedex.vsix`. Without Make, run the [equivalent npm commands](DEVELOPMENT.md#commands). You can also download a VSIX built from the same commit from GitHub Actions.

Install the resulting file using VS Code's **Extensions → … → Install from VSIX…** command. Test it with the current official Codex extension: send to an existing conversation, create a new conversation, and edit or remove a scheduled task.

## Visual Studio Marketplace

1. Sign in to the [publisher management page for IThlet](https://marketplace.visualstudio.com/manage/publishers/IThlet).
2. For the first publication, choose **New extension → Visual Studio Code** and upload the tested `schedex.vsix`.
3. For later versions, select the existing **Schedex** extension and upload the new VSIX through **Update**.
4. Check the description, screenshots, and version on the published extension page.

The publisher in `package.json` must remain **IThlet**; the extension ID is **IThlet.schedex**. Each update must use a new version number.

See the [official manual publishing instructions](https://code.visualstudio.com/api/working-with-extensions/publishing-extension#publish-an-extension).

## GitHub Releases

To keep downloadable copies of all published versions:

1. Commit and push the source corresponding to the tested VSIX.
2. In the GitHub repository, open **Releases → Draft a new release** and select or create a matching tag, such as **v1.0.0**, at that commit.
3. Add a short description and upload the same tested VSIX to the release's attachments area. A descriptive filename such as `schedex-1.0.0.vsix` is useful.
4. Publish the release.

GitHub Releases and Marketplace uploads are performed manually. CI only validates the code and builds a package.

VSIX files are excluded from Git. Build scripts, tests, development settings, and maintainer documentation in `docs/` are excluded from the VSIX. The screenshot referenced by the README is included.
