# Examples

Do-files for trying the extension and checking that each feature works. They use Stata's built-in datasets (`auto`, `nlsw88`), so they run anywhere.

| File | Exercises |
|------|-----------|
| `00_run_all.do` | Runs the others in one session (nested `do` files) |
| `01_basic.do` | Loading data, `generate`, `summarize`, `tabulate`, Variables panel |
| `02_regression.do` | Regressions, post-estimation, Stored Results panel |
| `03_graphics.do` | Plot capture and the Plots panel |
| `04_data_management.do` | `merge`, `reshape`, `collapse` and friends |
| `05_programming.do` | Loops, programs, macros, tempfiles, timers |
| `06_interactive.do` | Lines to run one at a time with `Cmd/Ctrl+Enter` |
| `07_snippets_test.do` | Snippets |
| `08_error_stop_test.do` | Error handling and the red underline on the failing line |
| `09_outline_demo.do` | Sections in the Outline view |

Open a file and press `Cmd+Shift+D` (`Ctrl+Shift+D` on Windows/Linux) to run it, or select lines and run just those. `00_run_all.do` calls the others by relative path, so run it from this folder: a console opened by running it starts here. Graphs exported by `03_graphics.do` (`test_plot*.png`) are written here and ignored by git.
