"""Local stand-in for the official agent_bridge_client.py, copied over it in each test payload: the same `mcp` and
wrapper modes, over a Unix socket in /payload instead of Modal's TLS tunnel. Hippo needs no memory port forward."""
import os
import socket
import subprocess
import sys
import threading

SOCKET = "/payload/apps.sock"


def mcp() -> None:
    with socket.socket(socket.AF_UNIX) as connection:
        connection.connect(SOCKET)

        def send() -> None:
            try:
                while data := os.read(sys.stdin.fileno(), 65536):
                    connection.sendall(data)
                connection.shutdown(socket.SHUT_WR)
            except OSError:
                pass
        threading.Thread(target=send, daemon=True).start()
        while data := connection.recv(65536):
            sys.stdout.buffer.write(data)
            sys.stdout.buffer.flush()


def main() -> None:
    if sys.argv[1] == "mcp":
        mcp()
        return
    raise SystemExit(subprocess.call(sys.argv[1:]))


if __name__ == "__main__":
    main()
