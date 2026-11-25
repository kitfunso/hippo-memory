"""Transfer precisely one commit and its tree from a read-only local object database."""
import os
from pathlib import Path
import subprocess
import sys
import tempfile


def checkout(source: str, commit: str) -> None:
    work = Path.cwd().resolve()
    work.relative_to(Path("C:/z0-lessons/lesson-knockout").resolve())
    env = dict(os.environ, GIT_OPTIONAL_LOCKS="0", GIT_NO_LAZY_FETCH="1")
    git = ["git", "-C", source]
    tree = subprocess.check_output([*git, "rev-parse", f"{commit}^{{tree}}"], env=env).strip()
    listing = subprocess.check_output([*git, "ls-tree", "-rtz", commit], env=env)
    objects = {row.split(b"\t", 1)[0].split()[2] for row in listing.split(b"\0") if row
               and row.split(b" ", 2)[1] != b"commit"}
    objects.update([tree, commit.encode("ascii")])
    with tempfile.TemporaryFile(dir=work.parent) as pack:
        subprocess.run([*git, "pack-objects", "--stdout", "--threads=1"], env=env,
                       input=b"\n".join(sorted(objects))+b"\n", stdout=pack, check=True)
        pack.seek(0)
        subprocess.run(["git", "index-pack", "--stdin"], stdin=pack, stdout=subprocess.DEVNULL,
                       env=env, check=True)
    (work / ".git/shallow").write_text(commit+"\n", encoding="ascii")
    subprocess.run(["git", "-c", "core.longpaths=true", "checkout", "-q", "--detach", commit], env=env, check=True)


if __name__ == "__main__":
    checkout(*sys.argv[1:])
