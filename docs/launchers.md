# Launchers

Terminal remote control: opens a titled tab running the agent with its brief, confirms it started on screen, and refuses to close a window it did not launch. The opencode launcher hands the brief over as `--prompt` and proves the start from opencode's own session row, which names the model. The Claude Code launcher passes the brief as the initial prompt, can turn Remote Control on, and proves the start from the session's own transcript; with `--resume` it reopens an existing session and proves it from the rows written after the launch, and `claude-resume-set.sh` snapshots the live sessions before a reboot and replays them after.

Files: `bin/opencode-tab.sh`, `bin/claude-tab.sh`, `bin/claude-resume-set.sh`, `lib/tab-ledger.sh`
