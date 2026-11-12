"""Loader interface for the group B chat-QA harness (`../harness.py`, prereg Amendment 6).

A loader is one module in this package, named for its benchmark. It copies the authors' prompts and scoring from their
files and cites file:line for each. Module attributes:

    NAME     str   benchmark name, as written in result docs
    TOPK     int   memories shown per question: the authors' setting where they publish one, else 20
    LICENCE  str   licence of the data, for the result doc
    DATA_FILES  list[Path]   the data files, whose SHA-256 the harness records

    conversations() -> Iterator[(user_id, turns)]
        turns: list of {"role": str, "content": str, "timestamp": float | None}; timestamp is seconds since the epoch,
        None where the data holds no date (the server then dates the memory at ingestion, in order).

    questions() -> list[dict], in a fixed order, each holding
        qid, user_id, question (also the search query), gold, category (str), choices (list, multiple choice only),
        ask_after: int | None  how many of the user's turns exist when the question is asked (a mid-history question
        sees turns[:ask_after] and nothing later); None means after the whole history.

    answer_prompt(q, memories) -> (system, user)
        memories: the retrieved results, best first, each {"id", "memory", "score", "created_at"}.

    judge(q, answer) -> ("match", bool)                          scored by match, no model call
                      | ("llm", system, prompt, parse)           parse(reply_text) -> True | False | None
        answer is the answerer's whole reply. None from parse means the reply holds no verdict and the judge asks again.

The harness retrieves for a mid-history question from a store that holds only the turns before it: it adds turns up to
`ask_after`, searches, then adds more. Nothing after the question can be found.
"""
