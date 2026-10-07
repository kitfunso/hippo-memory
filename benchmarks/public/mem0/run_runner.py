"""Mem0's runner at 4b61c5d with one transport change: its HTTP timeout to the memory server, 300 s to 12 h.

A usage-limit wait behind the Mem0 server can outlast 300 s, and the runner resends a timed-out add, which would
store that turn twice. Usage: python run_runner.py <memory-benchmarks dir> <the runner's own arguments>
"""
import os
import runpy
import sys

runner_dir = os.path.abspath(sys.argv.pop(1))
os.chdir(runner_dir)
sys.path.insert(0, runner_dir)

from benchmarks.common import mem0_client  # noqa: E402

_init = mem0_client.Mem0Client.__init__


def _patient(self, *args, **kwargs):
    kwargs.setdefault("timeout", 12 * 3600.0)
    _init(self, *args, **kwargs)


mem0_client.Mem0Client.__init__ = _patient
runpy.run_module("benchmarks.locomo.run", run_name="__main__", alter_sys=True)
