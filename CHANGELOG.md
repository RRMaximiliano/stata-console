# Changelog

## 0.4.0

### Windows support
- New PyStata backend (Stata 17+, Python 3.8+) that runs Stata through Python. It is the default on Windows and works on macOS and Linux too.
- New settings: `stata.backend` (`auto` / `console` / `pystata`), `stata.pythonPath`, and `stata.installDir`.
- Stata auto-detection on Windows (`Program Files\Stata19`, `StataNow19`, and older versions), and Python discovery through the VS Code Python extension, `py -3`, or `PATH`.
- `Diagnose Stata Path Detection` now reports the backend, install directory, and Python version.

### Console
- Running code no longer changes Stata's working directory, matching Stata's Do-file Editor (0.3.2 ran `cd` to the do-file's folder before every run). Set `stata.workingDirectory` to `fileDirectory` for the old behavior. A console opened by running a do-file starts in that file's folder, as when Stata is launched by opening a do-file.
- Syntax highlighting in the console, radian-style: echoed commands and the line you type are colored like the editor (Dark+/Light+, following the theme). Setting: `stata.console.syntaxHighlighting`.
- Stata's `linesize` follows the console width, so long lines wrap less. Setting: `stata.console.matchTerminalWidth`.
- Cleaner output: no stray `.` prompt lines or leaked internal commands, and one blank line between commands.
- Completion is detected exactly, so the prompt and the busy indicator no longer rely on output going quiet.
- Multi-line input (`forvalues … {`, `program … end`, `mata … end`, `///`) can be typed interactively.
- Line editing: arrow keys, Home/End, and Ctrl+A/E/U/K/W. Multi-line paste and type-ahead work.
- Sidebar panels refresh after interactive commands as well as after Run.
- Fixed: `r()` results were overwritten after every run, so `return list` showed the wrong values.
- Fixed: duplicate plots after non-graph commands; quotes and tabs in labels breaking the Variables panel; another window's session files being deleted.
- `browse` applies `stata.browseRowLimit` inside Stata, so large datasets are no longer exported in full.

### Panels
- Stored Results shows `r()` scalars and macros next to `e()`.
- Data Viewer: faster virtualized rendering, correct sorting of numbers and missing values (`.`, `.a`–`.z`), state kept on refresh, theme-aware styling.
- Plots: zoom and pan, per-plot delete, duplicate detection by content.
- Variables: filter and sort, plus type icons.
- Security: strict Content-Security-Policy and escaping in every webview; the help viewer only follows safe links.

### Editor
- `Cmd/Ctrl+Enter` runs the current line or selection (`Shift+Enter` still works). `Cmd/Ctrl+L` clears only the Stata console.
- File links handle Windows paths, `$globals`, preceding `cd`, and implicit extensions.
- Completion for local and global macros and for the current dataset's variables. Hover resolves abbreviations.
- Outline supports `**#` bookmarks. Go to Definition finds programs across the workspace.
- Grammar fixes for nested comments, compound strings, `#delimit ;`, Mata, and factor variables.

## 0.3.2

- Improved Stata executable auto-detection on macOS and Linux.
- Added `Stata: Diagnose Stata Path Detection` with copyable diagnostics output.
- Fixed Data Viewer column sorting to work under the current webview CSP.
- Improved CSV parsing in the Data Viewer for quoted values and embedded newlines.
- Attached Stata error diagnostics to the document that launched execution.
- Added linting, unit tests for path resolution, and CI verification.
