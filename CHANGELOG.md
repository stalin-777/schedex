# Changelog

## 1.1.0 - 2026-11-07

### Added

- **When Codex becomes available** mode: immediate and periodic checks for quota, connectivity, and service recovery, with a 1–30 day waiting deadline.
- Model and reasoning-effort selection for **New thread**, using the installed runtime's supported options.
- Conversation-change policies: send anyway, skip, or ask for confirmation. **Continue** defaults to skipping changed conversations.
- Built-in and custom prompt templates.
- Persistent task history with colored statuses, manual refresh, **Open in Codex**, pagination, and optional retention.
- Account binding in both send modes. Older unbound tasks require editing and saving before sending.
- Size limits for prompts, templates, local storage, and process output.

### Changed

- Reset-time suggestions now consider weekly limits alongside the 5-hour window.
- Existing conversations use their Codex settings and queue; prompt text is sent through RPC rather than process arguments.
- History refresh shares a client and conversation reads, and saves results in a batch.

### Fixed

- Recover from transient file-sharing errors, report permanent recovery errors, and preserve rescheduled tasks during sender cleanup.
- Scheduling captures conversation context before changing focus, handles repeated copying of the same link, requires a selection when unavailable, and loads the conversation list independently of model and quota requests.
- Opening a task for editing applies it before background loading, preserving subsequent form changes.
- Moving an uncertain delivery to History preserves Needs review and progress tracking instead of marking it cancelled.
- New-thread delivery avoids unpersisted-rollout errors and explains when the conversation can be opened in Codex.
- Uncertain submissions require review instead of automatic redelivery.
- Manual checks preserve account binding, attempt budget, and deadline. Availability uses project model settings and fresh quota data.
- History refresh reconciles incomplete statuses while retaining confirmed results and known timestamps.
- Command-menu editing opens the selected task, including in an already open panel.

## 1.0.0

- Initial release.
- Schedule prompts for existing or new Codex conversations, with persistent tasks and editing and removal controls.
- Suggest the 5-hour usage reset time plus one minute, with limited retries for rate-limit errors.
- Support English, Russian, and Simplified Chinese interfaces.
