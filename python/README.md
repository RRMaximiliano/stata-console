# PyStata bridge

Requires Stata 17+ and Python 3.8+; no pip packages are required. On Windows,
Python must be 64-bit and compatible with the installed Stata shared library.
`stata.installDir` points to the directory containing `utilities/pystata`.

The extension starts `stata_bridge.py` with `--stata-dir`, `--edition mp|se|be`,
and a random `--token`. Python runs unbuffered with UTF-8 pipes. It imports
PyStata from that installation and retains the Windows DLL search directory
through shutdown.

Stdin accepts one JSON object per line:

```json
{"type":"run","id":1,"commands":["sysuse auto, clear","summarize mpg"]}
{"type":"break"}
{"type":"stop"}
```

Each command is a single Stata line. Use `do "path/to/file.do"` for a block.
Standalone `mata`/`python` prompts are rejected because stdin carries the bridge
protocol; use inline `mata: ...`/`python: ...` commands or complete do-files.
Commands execute sequentially on the main thread. A Stata error prints its
returned error output and execution continues with the next command in the
batch, including post-processing commands. The reader thread calls only
`StataSO_SetBreak()` while a command is executing; break never sends SIGINT.

Stdout contains ordinary Stata text and control records. A control record is
on its own line and starts with the literal record separator character
`\x1e`, followed by `STATA_BRIDGE:<token>:` and a JSON object. The random token
prevents ordinary Stata output from being interpreted as a control record.
Records are `{"type":"ready"}`, `{"type":"done","id":1}`,
`{"type":"init_error","message":"..."}`, or
`{"type":"error","message":"..."}`. The parser strips them and normalizes
CRLF. PyStata joins its output timer before returning from `stata.run()`, so
the batch's `done` record follows all its output, including returned errors.
Diagnostic Python stderr is forwarded separately.

`stop` discards queued work, breaks an active command, runs `exit, clear`, and
exits. The TypeScript backend kills the worker if shutdown exceeds two seconds.
EOF without `stop` drains queued requests and then exits gracefully.

Run the optional real-Stata test after compiling:

```sh
STATA_INTEGRATION=1 STATA_INSTALL_DIR=/Applications/StataNow \
  STATA_PYTHON=/opt/homebrew/bin/python3 node --test test/pystata.integration.test.js
```

`STATA_EDITION` defaults to `mp`. On Windows, set the same environment variables
using PowerShell or Command Prompt, with a full Python executable path.
