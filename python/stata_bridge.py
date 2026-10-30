"""PyStata worker. stdin is JSONL; stdout is text plus token-prefixed JSONL."""

import argparse
import json
import os
import queue
import struct
import sys
import threading


class Output:
    def __init__(self, stream, token):
        self.stream = stream
        self.marker = '\x1eSTATA_BRIDGE:' + token + ':'
        self.lock = threading.RLock()
        self.line_start = True

    def __getattr__(self, name):
        return getattr(self.stream, name)

    def write(self, text):
        with self.lock:
            self.stream.write(text)
            if text:
                self.line_start = text.endswith('\n')
            self.stream.flush()
        return len(text)

    def flush(self):
        with self.lock:
            self.stream.flush()

    def control(self, message):
        with self.lock:
            if not self.line_start:
                self.stream.write('\n')
            self.stream.write(self.marker + json.dumps(message, ensure_ascii=True) + '\n')
            self.stream.flush()
            self.line_start = True


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--stata-dir', required=True)
    parser.add_argument('--edition', choices=['mp', 'se', 'be'], default='mp')
    parser.add_argument('--token', default='')
    args = parser.parse_args()

    sys.stdin.reconfigure(encoding='utf-8', errors='replace')
    sys.stdout.reconfigure(encoding='utf-8', errors='replace', newline='\n', write_through=True)
    sys.stderr.reconfigure(encoding='utf-8', errors='replace', newline='\n', write_through=True)
    output = Output(sys.stdout, args.token)
    sys.stdout = output
    stata_dir = os.path.realpath(args.stata_dir)
    dll_directory = None
    try:
        if not os.path.isdir(os.path.join(stata_dir, 'utilities', 'pystata')):
            raise RuntimeError('PyStata is missing. Stata 17+ is required; set stata.installDir to the directory containing utilities/pystata.')
        if sys.platform == 'win32':
            if struct.calcsize('P') != 8:
                raise RuntimeError('64-bit Python is required for Windows Stata. Set stata.pythonPath to a 64-bit Python 3.8+ executable.')
            dll_directory = os.add_dll_directory(stata_dir)
            os.environ['PATH'] = stata_dir + os.pathsep + os.environ.get('PATH', '')
        sys.path.insert(0, os.path.join(stata_dir, 'utilities'))
        from pystata import config
        config.stoutputf = output
        config.init(args.edition, splash=False)
        if not config.is_stata_initialized() or not config.sfiinitialized:
            raise RuntimeError('Stata initialization failed. Open Stata once to check its license.')
        from pystata import stata
        config.set_graph_show(False)
        streaming = getattr(config, 'set_streaming_output_mode', None)
        if streaming is not None:
            streaming('on')
        config.stlib.StataSO_SetBreak.argtypes = []
        config.stlib.StataSO_SetBreak.restype = None
        stata.run('set more off', echo=False)
    except Exception as exc:
        detail = ' '.join(str(exc).split()) or type(exc).__name__
        output.control({
            'type': 'init_error',
            'message': 'PyStata initialization failed: ' + detail
            + ' Check stata.installDir, stata.stataEdition, the Stata license, and Python/Stata architecture compatibility.',
        })
        return 1

    requests = queue.Queue()
    stopping = threading.Event()
    state_lock = threading.Lock()
    executing = False

    def request_break():
        # CDLL releases the GIL while Stata executes. This is the only Stata
        # library call made by the reader; execution stays on the main thread.
        with state_lock:
            if executing:
                config.stlib.StataSO_SetBreak()

    def read_input():
        try:
            for line in sys.stdin:
                try:
                    message = json.loads(line)
                    if not isinstance(message, dict):
                        raise ValueError('expected a JSON object')
                    kind = message.get('type')
                    if kind == 'break':
                        request_break()
                    elif kind == 'stop':
                        stopping.set()
                        request_break()
                        break
                    elif kind == 'run':
                        commands = message.get('commands')
                        batch_id = message.get('id')
                        if type(batch_id) is not int or not isinstance(commands, list) or not all(
                            isinstance(cmd, str) and '\n' not in cmd and '\r' not in cmd for cmd in commands
                        ):
                            raise ValueError('run requires an integer id and single-line commands')
                        requests.put(message)
                    else:
                        raise ValueError('unknown request type')
                except (ValueError, TypeError) as exc:
                    output.control({'type': 'error', 'message': 'Invalid bridge request: ' + str(exc)})
        finally:
            requests.put(None)

    threading.Thread(target=read_input, name='bridge-stdin', daemon=True).start()
    output.control({'type': 'ready'})
    try:
        while not stopping.is_set():
            request = requests.get()
            if request is None or stopping.is_set():
                break
            for command in request['commands']:
                with state_lock:
                    if stopping.is_set():
                        break
                    executing = True
                try:
                    if command.strip() in ('mata', 'mata:', 'python', 'python:'):
                        raise RuntimeError('Interactive Mata/Python prompts cannot read the bridge protocol. Use a do-file or an inline mata:/python: command instead.')
                    stata.run(command, echo=True)
                except SystemError as exc:
                    # Error output is returned by PyStata, not printed by its timer.
                    output.write(str(exc).rstrip('\r\n') + '\n')
                except Exception as exc:
                    output.control({'type': 'error', 'message': 'PyStata execution failed: ' + str(exc)})
                finally:
                    with state_lock:
                        executing = False
            output.control({'type': 'done', 'id': request['id']})
    finally:
        try:
            stata.run('exit, clear', echo=False)
        except SystemError:
            pass
        # Keep the Windows DLL search handle alive through Stata's atexit shutdown.
        if dll_directory is not None:
            config._bridge_dll_directory = dll_directory
    return 0


if __name__ == '__main__':
    sys.exit(main())
