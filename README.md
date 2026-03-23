# Stata Console for VS Code

This extension embeds an interactive Stata session directly inside Visual Studio Code. Instead of switching between VS Code and Stata's GUI, you get a terminal, data viewer, variables panel, plots pane, and stored results inspector all within the editor.

The current design is inspired by [Positron](https://positron.posit.co/) and how it integrates R into the IDE, i.e., a unified workspace where the console, environment, data viewer, and plots live alongside your code.

## What it does

Right now, the extension does the following:

- **Console.** A pseudoterminal wraps Stata's command-line interface. You type commands, see output, and interact with Stata without leaving VS Code. The output is color-coded: commands in blue, errors in red, table separators in gray.
- **Run code from the editor.** Select lines in a `.do` file and press `Cmd+Shift+D` to execute them. `Cmd+Enter` runs the current line and advances the cursor. Right-click for context menu options. The extension writes your code to a temporary do-file and runs it, so comments (`//`, `///`, `/* */`) work correctly.
- **Data Viewer.** Type `browse` in the console or include it in a do-file. Instead of failing (as it normally does in console mode), the extension exports the data to CSV and displays it in a spreadsheet-like panel with sortable columns, row numbers, search filtering, and a row count. Supports `browse varlist if condition in range` syntax. However, if you use dofiles within dofiles, the browse command won't work. I don't know how to fix it yet. So, just remove `browse` if you are running, for example, a `00_main.do`
- **Variables panel.** Shows every variable in the loaded dataset with its name, type, and label. Click a variable to insert its name at the cursor. Auto-refreshes after each code execution.
- **Dataset info.** Displays the filename, observation count, variable count, and data label. The status bar also shows this at a glance.
- **Stored results.** After running a regression or estimation command, the panel shows `e()` scalars (N, R-squared, F-statistic, etc.) and macros (command name, dependent variable, etc.). Updates automatically.
- **Plots.** Every graph command (`scatter`, `histogram`, `twoway`, `graph bar`, etc.) is captured and displayed in a side panel. Multiple plots are preserved in a navigable history with back/forward buttons and a save option. A plots list in the sidebar shows all generated plots with timestamps. You can also remove the plots if you don't want them to be kept in the side panel.
- **Syntax highlighting.** Full TextMate grammar for `.do`, `.ado`, `.mata`, and `.sthlp` files covering commands, comments, strings, macros, numbers, operators, and control flow.
- **Auto-completion.** Over 120 Stata commands with descriptions — data management, estimation, post-estimation, graphics, programming, and more. Type `reg` and see `regress — Linear regression (OLS)`.
- **Snippets.** 19 templates for common patterns: `foreach`, `forvalues`, `program...end`, `reghdfe`, `merge`, `collapse`, `twoway` graph, do-file header with date and project paths, `preserve...restore`, and others. Type the prefix and press Tab.
- **Hover help.** Hover over any Stata command to see a brief description.
- **Outline.** The Outline panel (`Cmd+Shift+O`) shows the structure of your do-file: section headers, program definitions, and loops. Section detection works with common Stata conventions — numbered sections (`* 1. Title`), separator-bordered sections (`* --- Title ---`), and ALL CAPS headers.
- **Go to definition.** `Cmd+Click` on a program name to jump to its `program define` in the same file.
- **File links.** Paths in `do`, `run`, `use`, `save`, `import using`, `graph export`, and similar commands are clickable — `Cmd+Click` to open the referenced file. I haven not tested this with globals. 
- **Error diagnostics.** When Stata returns an error, the offending line in the editor gets a red underline with the error message. Cleared on the next run.

## Keyboard shortcuts

| Shortcut | Action |
|----------|--------|
| `Cmd+Shift+D` | Run do-file or selection |
| `Shift+Enter` | Run current line and advance cursor |
| `Cmd+L` | Clear console |
| `Ctrl+C` | Interrupt execution |
| `Cmd+/` | Toggle line comments |
| `Cmd+Shift+O` | Open outline |

All shortcuts can be customized via `Cmd+K Cmd+S` (Keyboard Shortcuts).

## Sidebar panels

The Stata icon in the Activity Bar opens four panels:

- **Data** — dataset name, observations, variables, label
- **Variables** — variable list with types, labels, and icons
- **Stored Results** — estimation scalars and macros after regressions
- **Plots** — history of generated plots (click to view, trash icon to clear)

## Settings

| Setting | Default | Description |
|---------|---------|-------------|
| `stata.stataPath` | (auto-detect) | Full path to the Stata executable |
| `stata.stataEdition` | MP | Preferred edition: MP, SE, or BE |
| `stata.browseRowLimit` | 10000 | Max rows shown in the Data Viewer |
| `stata.colors.prompt` | `#4E9A6A` | Color of the `. ` prompt (hex) |
| `stata.colors.command` | `#569CD6` | Color of echoed commands (hex) |
| `stata.colors.error` | `#CC3E44` | Color of error messages (hex) |
| `stata.colors.tableSeparator` | `#B4B4B4` | Color of table separator lines (hex) |
| `stata.colors.dim` | `#787878` | Color of dimmed/info text (hex) |

Auto-detection searches standard installation paths on macOS, Windows, and Linux for Stata versions 14 through 19. Console colors take effect when the Stata console is opened or restarted.

## How it works

The extension spawns Stata in console mode (`stata-mp -q`) as a child process with piped stdin/stdout. User code is written to temporary do-files and executed via Stata's `do` command, preserving full comment and continuation syntax.

After each execution, a silent post-processing step runs via Stata's `run` command (which produces zero output). This extracts variable metadata, dataset info, estimation results, and captures graphs — all without any visible terminal noise.

Graph commands are detected in the code and a `graph export` is injected after each one, writing to uniquely-named PNG files. A filesystem watcher detects new files and displays them immediately.

The `browse` command is intercepted and replaced with an `export delimited` that writes a CSV, which the Data Viewer renders as a sortable table.

Right now, this extension is slower than regular Stata. That's it, that's the message. Up to you how you want to use it. 

## Known limitations

- **`browse` in nested do-files.** When a do-file calls `do "other.do"`, the extension cannot intercept `browse` inside the nested file because Stata reads it directly from disk. Use `browse` interactively or in directly-run code.
- **Graphs from nested do-files.** Only the last graph from a nested `do` call is captured (via the post-execution fallback). Directly-run code captures every graph.
- **Stored results.** Only `e()` scalars and macros are shown. `r()` return values are not currently captured.
- **Go to definition.** Works within the current file only.

## Installation

**From the Marketplace:**
Search for "Stata Console" in the VS Code Extensions panel (`Cmd+Shift+X`), or visit [the marketplace page](https://marketplace.visualstudio.com/items?itemName=rrmaximiliano.stata-console).

**From a `.vsix` file:**
Download the latest `.vsix` from [GitHub Releases](https://github.com/RRMaximiliano/stata-console/releases), then run:
```
code --install-extension stata-console-0.3.0.vsix
```

**From source:**
```
git clone https://github.com/RRMaximiliano/stata-console.git
cd stata-console
npm install
npm run compile
```
Then open the folder in VS Code and press `F5` to launch the Extension Development Host.

## Requirements

- Stata 14 or later (MP, SE, or BE) installed on your system
- VS Code 1.80.0 or later

## Acknowledgments

The workspace layout — with a variables panel, data viewer, and plots pane alongside the console — is directly inspired by [Positron](https://positron.posit.co/) and how it integrates R. The idea of `run` for silent background commands, inline graph capture, and auto-refreshing metadata all came from studying how Positron achieves a seamless R development experience without polluting the console.

The extension was built to bring a similar level of integration to Stata, a tool that has traditionally required its own standalone GUI.

> Note. I don't think I will have the time to continue with this project, but you are more than welcome to fork this extension and make it as you wish.