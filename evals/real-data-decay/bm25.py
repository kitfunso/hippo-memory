"""Hand-written BM25 over a single hippo store, stdlib only.

Corpus statistics (N, avgdl, df) are computed "as of t" per query, not once
globally, because the prereg requires the store to look the way it did at
query time (memories created after t must not exist yet).
"""
import re
from bisect import bisect_right

STOP = set("the a an and or of to in on for is are was were be it this that with as at by from not no".split())
TOKEN_RE = re.compile(r"[a-z0-9_]{3,}")

K1 = 1.5
B = 0.75


def tokenize(text: str) -> list[str]:
    return [w for w in TOKEN_RE.findall((text or "").lower()) if w not in STOP]


class BM25Store:
    """Indexes one store's memories for as-of-t BM25 scoring."""

    def __init__(self, docs: list[tuple[str, float, str]]):
        # docs: (id, created_epoch_days, content)
        self.ids = [d[0] for d in docs]
        self.created = {d[0]: d[1] for d in docs}
        self.doc_len = {}
        self.tf = {}  # doc_id -> {term: count}
        postings = {}  # term -> list of (created, doc_id)
        for doc_id, created, content in docs:
            toks = tokenize(content)
            self.doc_len[doc_id] = len(toks)
            counts = {}
            for w in toks:
                counts[w] = counts.get(w, 0) + 1
            self.tf[doc_id] = counts
            for w in counts:
                postings.setdefault(w, []).append((created, doc_id))
        # sort each posting list by created so df-as-of-t is a bisect
        for w in postings:
            postings[w].sort(key=lambda x: x[0])
        self.postings = postings
        all_created = sorted(self.created[d] for d in self.ids)
        self.all_created_sorted = all_created

    def score(self, query_tokens: list[str], t: float):
        """Return {doc_id: bm25_score} for docs created<=t sharing >=1 term."""
        n_t = bisect_right(self.all_created_sorted, t)
        if n_t == 0:
            return {}
        # avgdl over docs created<=t
        total_len = 0
        count = 0
        for d in self.ids:
            if self.created[d] <= t:
                total_len += self.doc_len[d]
                count += 1
        if count == 0:
            return {}
        avgdl = total_len / count

        scores: dict[str, float] = {}
        seen_terms = set()
        for term in query_tokens:
            if term in seen_terms:
                continue
            seen_terms.add(term)
            plist = self.postings.get(term)
            if not plist:
                continue
            df_t = bisect_right([c for c, _ in plist], t)
            if df_t == 0:
                continue
            idf = _idf(n_t, df_t)
            for created, doc_id in plist[:df_t]:
                f = self.tf[doc_id][term]
                dl = self.doc_len[doc_id]
                denom = f + K1 * (1 - B + B * dl / avgdl)
                s = idf * (f * (K1 + 1)) / denom
                scores[doc_id] = scores.get(doc_id, 0.0) + s
        return scores


def _idf(n: int, df: int) -> float:
    import math
    return math.log((n - df + 0.5) / (df + 0.5) + 1)
