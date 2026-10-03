# Schedex

**Schedule a prompt for an existing or new Codex conversation and continue automatically after your usage limit resets.**

Schedex helps when Codex reaches its 5-hour usage limit while a task is still in progress. Schedule a follow-up prompt now, and Schedex sends it to the selected Codex conversation later or starts a clean one.

![Schedex scheduling panel with thread selection, date and time controls, prompt field, and scheduled tasks](docs/screenshot.png)

## Quick start

1. Open the Codex conversation you want to continue, or choose **New thread** in Schedex.
2. Click the **Schedex** calendar/send icon in the Codex header, or right-click inside Codex and choose **Schedule prompt**.
3. Check the selected thread and send time. When available, Schedex suggests **5-hour reset + 1 minute** automatically.
4. Choose an existing conversation or **New thread**, edit the prompt, and click **Schedule**.

After scheduling, the task appears in the **Scheduled** list below the form. The form keeps its values, so you can change the time or other fields to schedule another task. You can edit or remove an existing task from the list.

## Thread selection

The scheduling tab loads recent Codex conversations into a searchable selector. Search by:

- conversation title;
- preview text;
- thread UUID.

Schedex tries to select the currently open conversation automatically. You can always choose another thread. If a Codex build does not expose enough context, **Copy deeplink** is available as a fallback.

Choose **New thread** to start a fresh Codex conversation when the task is sent. Schedex saves the new thread ID before sending the prompt, so retries use the same conversation.

## Date and time

When the current 5-hour usage window is available, Schedex suggests **reset time + 1 minute**. If Codex is still rate-limited at that moment, Schedex retries every two minutes, up to five times.

## Language

Schedex follows the **VS Code display language** automatically.

Included UI languages:

- English;
- Russian;
- Simplified Chinese.

Other VS Code display languages fall back to English.

To change the language, open the Command Palette and run **Configure Display Language**, choose a language, then restart or reload VS Code when prompted.

## Platforms

Schedex is designed to work with the official Codex extension on:

- Windows;
- macOS (Intel and Apple Silicon);
- Linux;
- VS Code Remote — WSL.

Prompt delivery has been manually verified in WSL with the official Codex extension.

## Requirements

- Visual Studio Code **1.106.0 or later**;
- the official **OpenAI Codex** extension (`openai.chatgpt`).

A separate global Codex CLI installation is not required.

## When VS Code is closed

Schedex runs inside the VS Code extension host, not as a system service. It cannot send while that extension host is completely stopped.

Scheduled jobs are stored persistently. If a send time passes while VS Code is closed, the overdue job is processed when Schedex starts again.

## Scheduled prompts

The Schedex status-bar item shows pending jobs and opens the scheduling panel. In the **Scheduled** list you can:

- edit the thread, prompt, or send time;
- remove a scheduled or failed job.

The **Schedex: Scheduled prompts** command also offers immediate send and retry actions.

## Privacy

Schedex stores scheduled prompts and Codex thread IDs in VS Code extension storage on your machine. It does not add a separate cloud service. Sending is performed through the Codex runtime bundled with the official OpenAI extension.

## Troubleshooting

If Schedex cannot determine the intended thread, use Codex **Copy deeplink** and run **Schedex: Use thread from Copy deeplink** once.

For UI integration problems, run **Schedex: UI diagnostics** to inspect the Codex view IDs and commands exposed by the installed Codex extension.

## License

MIT. See [LICENSE](LICENSE).

## Support

Report bugs and request features in [GitHub Issues](https://github.com/stalin-777/schedex/issues). Include the VS Code and Codex extension versions, your operating system, and steps to reproduce the issue.

You can also contact the author on Telegram: [@bambucha762](https://t.me/bambucha762).

## Repository documentation

- [Development, debugging, and CI](docs/DEVELOPMENT.md)
- [Manual packaging and publication](docs/PUBLISHING.md)
