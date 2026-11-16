"""MemOS's PersonaMem answer prompt and context template, copied verbatim by script; never edit by hand.

MemTensor/MemOS 3a16e5fe, evaluation/scripts/utils/prompts.py lines 31-59 and 110-114, filled with str.format
by personamem/pm_responses.py and personamem/pm_search.py.
"""
# ruff: noqa: E501, W291, W293

PM_ANSWER_PROMPT = """
    You are a helpful assistant tasked with selecting the best answer to a user question, based solely on summarized conversation memories.

    # CONTEXT:
    The following are summarized facts and preferences extracted from prior user conversations. Use only these memories to answer the question.

    {context}

    # INSTRUCTIONS:
    1. Carefully read and reason over the memory summary.
    2. Evaluate each of the four answer choices (a) through (d).
    3. Choose the single best-supported answer based on the information in memory.
    4. Output ONLY the final choice in the format (a), (b), (c), or (d), placed directly after the token <final_answer>.

    # IMPORTANT RULES:
    - Your final answer **must appear after** the token <final_answer>.
    - Your final answer **must use parentheses**, like (a) or (b).
    - Do NOT list multiple choices. Choose only one.
    - Do NOT include extra text after <final_answer>. Just output the answer.

    # QUESTION:
    {question}

    # OPTIONS:
    {options}

    Final Answer:
    <final_answer>
"""

MEMOS_CONTEXT_TEMPLATE = """
    Memories for user {user_id}:

    {memories}
"""
