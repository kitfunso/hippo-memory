"""Zep's DMR answer and grader prompts and the grader's response format, copied verbatim by script; never edit
by hand.

getzep/zep 1659df1a benchmarks/longmemeval/zep_memgpt_eval.ipynb cell 8: dmr_response (system_prompt, prompt) and
dmr_grader (system_prompt, prompt), each f-string as a str.format template of the same text. GRADE_FORMAT is the
response_format openai-python sends for its Grade model (beta.chat.completions.parse).
"""
# ruff: noqa: E501, W291, W293

ANSWER_SYSTEM = """
        You are speaker A and should respond to all questions in the the first person perspective of A
        """

ANSWER_PROMPT = """
            Your task is to briefly answer the question. You are given the following context from the previous conversation. If you don't know how to answer the question, abstain from answering.
                <CONTEXT>
                {context}
                </CONTEXT>
                <QUESTION>
                {question}
                </QUESTION>

            Respond with an ANSWER section containing your answer. As well as an EVIDENCE section containing the context that help you came to your conclusion, and an explanation of why that context is relevant.
            """

GRADER_SYSTEM = """
        You are an expert grader that determines if answers to questions match a gold standard answer
        """

GRADER_PROMPT = """         
    I will give you a question, a correct answer, and a response from a model. Please answer true if the response contains the correct answer or touches on the same topic. Otherwise, answer false. If the response is equivalent to the correct answer or contains all the intermediate steps to get the correct answer, you should also answer true. If the response only contains a subset of the information required by the answer, answer false.
            
    <QUESTION>
    B: {question}
    </QUESTION>
    <CORRECT ANSWER>
    {gold_answer}
    </CORRECT ANSWER>
    <RESPONSE>
    A: {response}
    </RESPONSE>
    """

GRADE_FORMAT = '{"type": "json_schema", "json_schema": {"schema": {"properties": {"is_correct": {"description": "Whether or not the response is correct", "title": "Is Correct", "type": "boolean"}}, "required": ["is_correct"], "title": "Grade", "type": "object", "additionalProperties": false}, "name": "Grade", "strict": true}}'
