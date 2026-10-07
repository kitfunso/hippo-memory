"""mem0_server.py with one fix to Mem0 (prereg Amendment 6): its batch entity search asks Qdrant for payloads.

mem0ai 5e941e2's Qdrant.search_batch (qdrant.py:381-396) builds each QueryRequest without with_payload, which Qdrant's
query API reads as false, so main.py:769-781 updates every matched entity from an empty payload and it keeps only the
latest add's links. The copy below differs from Mem0's in that one argument. Usage: as mem0_server.py.
"""
import mem0_server  # first: it sets Mem0's environment before Mem0 is imported
from mem0.vector_stores import qdrant


def search_batch(self, queries: list, vectors_list: list, top_k: int = 1, filters: dict = None):
    query_filter = self._create_filter(filters) if filters else None
    requests = [
        qdrant.models.QueryRequest(query=vec, filter=query_filter, limit=top_k, with_payload=True)
        for vec in vectors_list
    ]
    try:
        results = self.client.query_batch_points(
            collection_name=self.collection_name,
            requests=requests,
        )
        return [r.points for r in results]
    except Exception as e:
        qdrant.logger.warning(f"Batch search failed, falling back to sequential: {e}")
        return [self.search(q, v, top_k=top_k, filters=filters) for q, v in zip(queries, vectors_list)]


qdrant.Qdrant.search_batch = search_batch

if __name__ == "__main__":
    mem0_server.main()
