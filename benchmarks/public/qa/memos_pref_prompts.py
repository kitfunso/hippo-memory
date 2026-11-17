"""MemOS's PrefEval answer prompt, irrelevant turns, four checks and their parse, copied verbatim by script; never
edit by hand.

MemTensor/MemOS 3a16e5fe evaluation/scripts: utils/prompts.py lines 62-66 (PREFEVAL_ANSWER_PROMPT),
PrefEval/irrelevant_conv.py lines 1-67 (irre_10), and PrefEval/pref_eval.py: the f-string prompts of lines 49-69,
81-100, 113-132 and 144-172 as str.format templates of the same text, parse_xml_response (41-43) and
classify_error_type (181-196).
"""
# ruff: noqa: E501, W291, W293
import re
from typing import Any

PREFEVAL_ANSWER_PROMPT = """
    You are a helpful AI. Answer the question based on the query and the following memories:
    User Memories:
    {context}
"""

irre_10 = [
    {
        "content": '"""Calculates a fibonacci of a given number"""\n\ndef fibonacci(number):\n    """returns fibonacci with memoization"""\n    memo = {0: 0, 1: 1}\n    if not number in memo:\n        memo[number] = fibonacci(number-1) + fibonacci(number-2)\n    return memo[number]\n\nCONVERT THIS TO GOLANG',
        "role": "user",
    },
    {
        "content": "Here is the equivalent Fibonacci function in Go:\n\n```go\nfunc fibonacci(number int) int {\n    memo := map[int]int{0: 0, 1: 1}\n    if _, ok := memo[number]; !ok {\n        memo[number] = fibonacci(number-1) + fibonacci(number-2)\n    }\n    return memo[number]\n}\n```\n\nSome key differences from Python:\n\n- Use `map[int]int` to declare a map (dict in Python)\n- Use `_, ok := memo[number]` to check if a key exists in the map. This returns two values - we ignore the first using `_` and check the `ok` boolean.\n- No need to indent for scopes - use `{` and `}`\n- Return values with `return` instead of implicitly \n- No need to specify types for function arguments - the type is inferred\n- Use `:=` for variable declaration and assignment instead of `=`\n\nOther than the syntactic differences, the logic remains the same - using memoization to cache the results of expensive function calls.",
        "role": "assistant",
    },
    {"content": "write 10 tests for it", "role": "user"},
    {
        "content": 'Here are 10 tests for the Fibonacci function in Go:\n\n```go\nfunc TestFibonacci(t *testing.T) {\n    tests := []struct {\n        input int\n        expected int\n    }{\n        {0, 0},\n        {1, 1},\n        {2, 1},\n        {3, 2},\n        {4, 3},\n        {5, 5},\n        {6, 8},\n        {7, 13},\n        {8, 21},\n        {9, 34},\n    }\n\n    for _, test := range tests {\n        actual := fibonacci(test.input)\n        if actual != test.expected {\n            t.Errorf("For input %d, expected %d but got %d", test.input, test.expected, actual)\n        }\n    }\n}\n```\n\nSome notes:\n\n- We use a `testing.T` which implements the `testing.TB` interface. This is passed to test functions by the Go test runner.\n- We define a list of test cases using the `tests` slice. Each test case has an input and expected output.\n- We loop through each test case and call the `fibonacci` function, asserting that the actual result matches the expected result. \n- If there is a mismatch, we call `t.Errorf` to log a failing test message.\n- The Go test runner will run all tests in files named `*_test.go` and report any failures.\n\nSo this gives us a good set of tests to validate the correctness of the `fibonacci` function. Let me know if you have any other questions!',
        "role": "assistant",
    },
    {
        "content": 'resource "kubernetes_ingress" "example_ingress" {\n  metadata {\n    name = "example-ingress"\n  }\n\n  spec {\n    backend {\n      service_name = "myapp-1"\n      service_port = 8080\n    }\n\n    rule {\n      http {\n        path {\n          backend {\n            service_name = "myapp-1"\n            service_port = 8080\n          }\n\n          path = "/app1/*"\n        }\n\n        path {\n          backend {\n            service_name = "myapp-2"\n            service_port = 8080\n          }\n\n          path = "/app2/*"\n        }\n      }\n    }\n\n    tls {\n      secret_name = "tls-secret"\n    }\n  }\n}\n\nrewrite this to point to service nginx-ingress at port 80 using       "kubernetes.io/ingress.class" = "nginx"\n',
        "role": "user",
    },
    {
        "content": 'Here is the Kubernetes Ingress resource rewritten to use the nginx-ingress controller:\n\n```hcl\nresource "kubernetes_ingress" "example_ingress" {\n  metadata {\n    name = "example-ingress"\n    annotations = {\n      "kubernetes.io/ingress.class" = "nginx"\n    }\n  }\n\n  spec {\n    backend {\n      service_name = "nginx-ingress"\n      service_port = 80\n    }\n\n    rule {\n      http {\n        path {\n          backend {\n            service_name = "myapp-1"\n            service_port = 8080\n          }\n\n          path = "/app1/*"\n        }\n\n        path {\n          backend {\n            service_name = "myapp-2"\n            service_port = 8080\n          }\n\n          path = "/app2/*"\n        }\n      }\n    }\n  }\n}\n```\n\nThe main changes are:\n\n- Removing the `tls` section since TLS will be handled by the ingress controller \n- Setting the `kubernetes.io/ingress.class` annotation to `nginx` to specify we want to use the nginx-ingress controller\n- Changing the `backend` service to `nginx-ingress` on port `80`\n- Removing the `service_port` from the path-specific backends since the ingress controller will forward to the correct port \n- The nginx-ingress controller will now receive all traffic on port 80 and forward to the appropriate backend based on the ingress paths.\n\nSo this ingress configuration will have the nginx-ingress controller handling all the ingress logic and routing traffic to the correct backend services. Let me know if you have any other questions!',
        "role": "assistant",
    },
    {"content": '           path = "/"\n', "role": "user"},
    {
        "content": 'To match all paths, you can use the `/` path in the ingress rule:\n\n```hcl\nresource "kubernetes_ingress" "example_ingress" {\n  # ...\n\n  spec {\n    # ...\n\n    rule {\n      http {\n        path {\n          backend {\n            service_name = "myapp-1"\n          }\n\n          path = "/" \n        }\n      }\n    }\n  } \n}\n```\n\nSetting the path to `/` will match all incoming requests and send them to the `myapp-1` backend service.\nSo the full ingress would look like this:\n\n```hcl\nresource "kubernetes_ingress" "example_ingress" {\n  metadata {\n    name = "example-ingress"\n    annotations = {\n      "kubernetes.io/ingress.class" = "nginx"\n    }\n  }\n\n  spec {\n    backend {\n      service_name = "nginx-ingress"\n      service_port = 80\n    }\n\n    rule {\n      http {\n        path {\n          backend {\n            service_name = "myapp-1"\n          }\n\n          path = "/" \n        }\n\n        path {\n          backend {\n            service_name = "myapp-2"\n            service_port = 8080\n          }\n\n          path = "/app2/*"\n        }\n      }\n    }\n  }\n}\n```\n\nWith this configuration:\n\n- All requests (`/`) will be sent to the `myapp-1` backend\n- Requests to `/app2/*` will be sent to the `myapp-2` backend\n- The `nginx-ingress` controller will receive all traffic on port 80 and forward to the appropriate backend based on the ingress paths.\n\nLet me know if you have any other questions!',
        "role": "assistant",
    },
    {
        "content": "rewrite for a single path / to nginx-ingress backend and remove tls",
        "role": "user",
    },
    {
        "content": 'To rewrite the ingress to have a single path `/` that forwards to the `nginx-ingress` backend, you can use:\n\n```hcl\nresource "kubernetes_ingress" "example_ingress" {\n  metadata {\n    name = "example-ingress"\n    annotations = {\n      "kubernetes.io/ingress.class" = "nginx"\n    }\n  }\n\n  spec {\n    backend {\n      service_name = "nginx-ingress"\n      service_port = 80\n    }\n\n    rule {\n      http {\n        path {\n          backend {\n            service_name = "nginx-ingress"\n            service_port = 80\n          }\n\n          path = "/" \n        }\n      }\n    }\n  }\n}\n```\n\nThis ingress configuration:\n\n- Has a single path `/` that matches all requests\n- Forwards all requests to the `nginx-ingress` backend service on port 80\n- Does not have any TLS configuration\n- Relies entirely on the `nginx-ingress` controller to handle routing\n\nSo this is a very simple ingress configuration that passes all traffic to the ingress controller to handle. The controller can then determine routing based on additional ingress resources or its own internal configuration.\n\nLet me know if you have any other questions!',
        "role": "assistant",
    },
    {"content": "convert to kubernetes_ingress_v1", "role": "user"},
    {
        "content": 'To use the kubernetes_ingress_v1 resource instead, you can use:\n\n```hcl\nresource "kubernetes_ingress_v1" "example_ingress" {\n  metadata {\n    name = "example-ingress"\n    annotations = {\n      "kubernetes.io/ingress.class" = "nginx"\n    }\n  }\n\n  spec {\n    backend {\n      service_name = "nginx-ingress"\n      service_port = 80\n    }\n\n    rule {\n      http {\n        path {\n          backend {\n            service_name = "nginx-ingress"\n            service_port = 80\n          }\n\n          path = "/" \n        }\n      }\n    }\n  }\n}\n```\n\nThe kubernetes_ingress_v1 resource works the same as kubernetes_ingress, it just uses the V1 version of the Ingress API.\nSo this configuration is equivalent, it just uses the newer Terraform resource.\n\nSome key points:\n\n- We use `kubernetes_ingress_v1` instead of `kubernetes_ingress` \n- All other attributes remain the same \n- This will deploy an Ingress using the V1 API version instead of the default API version\n\nThe kubernetes_ingress_v1 resource was added to allow controlling the Kubernetes API version for Ingress resources. \nOther than the API version, the functionality is the same.\n\nLet me know if you have any other questions!',
        "role": "assistant",
    },
    {
        "content": '\u2502 An argument named "service_name" and service port is not expected here.',
        "role": "user",
    },
    {
        "content": 'That error is occurring because in the kubernetes_ingress_v1 resource, the `path` block no longer takes `service_name` and `service_port` attributes.\nInstead, it takes a `backend` block that defines the backend service.\n\nSo to fix that error, the ingress should be:\n\n```hcl\nresource "kubernetes_ingress_v1" "example_ingress" {\n  metadata {\n    name = "example-ingress"\n    annotations = {\n      "kubernetes.io/ingress.class" = "nginx"\n    }\n  }\n\n  spec {\n    backend {\n      service_name = "nginx-ingress"\n      service_port = 80\n    }\n\n    rule {\n      http {\n        path { \n          backend {\n            service_name = "nginx-ingress"\n            service_port = 80\n          }\n\n          path = "/" \n        }\n      }\n    }\n  }\n}\n```\n\nThe key changes are:\n\n- The `path` block no longer takes `service_name` and `service_port`\n- We add a `backend` block within the `path` block to specify the backend service \n- The `backend` block takes `service_name` and `service_port` to define the service\n\nSo in the kubernetes_ingress_v1 resource, a `path` rule associates a path with a backend service using the nested `backend` block.\nThe `service_name` and `service_port` attributes are moved into that `backend` block.\n\nWith this change, the ingress configuration should work as expected. Let me know if you have any other questions!',
        "role": "assistant",
    },
    {
        "content": "fa\u00e7a uma dieta com 344g carbos, 170g proteinas, 42g gorduras ",
        "role": "user",
    },
    {
        "content": "Aqui est\u00e1 uma dieta com aproximadamente 344g de carboidratos, 170g de prote\u00ednas e 42g de gorduras:\n\nCaf\u00e9 da manh\u00e3 (344g carbos, 34g prote\u00ednas, 12g gorduras):\n- 3 x\u00edcaras de cereais integrais (ex: aveia): 105g carbos, 10g prote\u00ednas, 6g gorduras \n- 1 banana m\u00e9dia: 27g carbos \n- 1 copo de leite desnatado: 12g carbos, 8g prote\u00ednas, 0g gorduras\n\nLanche da manh\u00e3 (86g carbos, 10g prote\u00ednas, 3g gorduras):\n- 2 fatias de p\u00e3o integral: 26g carbos, 10g prote\u00ednas \n- 1 colher de sopa de pasta de amendoim: 8g carbos, 2g prote\u00ednas, 3g gorduras\n- 1 ma\u00e7\u00e3 m\u00e9dia: 52g carbos\n\nAlmo\u00e7o (63g carbos, 26g prote\u00ednas, 3g gorduras):\n- 2 x\u00edcaras de arroz cozido: 54g carbos \n- 3 on\u00e7as de peito de frango grelhado: 26g prote\u00ednas \n- 1 colher de sopa de azeite NAME_1: 0g carbos, 0g prote\u00ednas, 3g gorduras\n- Salada de alface e tomate: 9g carbos \n\nLanche da tarde (34g carbos, 18g prote\u00ednas, 9g gorduras): \n- 1 barra de prote\u00edna: 34g carbos, 18g prote\u00ednas, 9g gorduras\n\nJantar (56g carbos, 26g prote\u00ednas, 6g gorduras):\n- 1 batata m\u00e9dia cozida: 56g carbos\n- 3 on\u00e7as de peixe grelhado: 26g prote\u00ednas\n- 1 colher de sopa de azeite NAME_1: 0g carbos, 0g prote\u00ednas, 6g gorduras\n\nSobremesa (45g carbos, 6g prote\u00ednas, 3g gorduras): \n- 1 fatia de bolo de chocolate: 45",
        "role": "assistant",
    },
    {"content": "sugira alimentos", "role": "user"},
    {
        "content": "Aqui est\u00e3o algumas sugest\u00f5es de alimentos para incluir em uma dieta com 344g de carboidratos, 170g de prote\u00ednas e 42g de gorduras:\n\nCarboidratos:\n- Arroz integral, quinoa, aveia, cereais integrais: \u00f3timas fontes de carboidratos complexos e fibras.\n- Batata, inhame, mandioca: carboidratos naturais com nutrientes. \n- Frutas como banana, ma\u00e7\u00e3, laranja: carboidratos com vitaminas e minerais.\n- P\u00e3o integral, tortillas, lavash: escolha op\u00e7\u00f5es integrais com poucos ingredientes.\n\nProte\u00ednas:\n- Peito de frango, peixe como salm\u00e3o e atum, ovo: excelentes fontes de prote\u00edna magra. \n- NAME_2, leite: op\u00e7\u00f5es l\u00e1cteas com prote\u00ednas e nutrientes. \n- Feij\u00f5es, lentilhas, gr\u00e3o-de-bico: legumes ricos em prote\u00ednas, fibras e nutrientes.\n- Tofu, seitan, prote\u00edna de soja texturizada: op\u00e7\u00f5es \u00e0 base de plantas para quem n\u00e3o come carne.\n\nGorduras boas:\n- Azeite NAME_1, abacate, nozes, sementes: gorduras monoinsaturadas e poli-insaturadas que fornecem energia e nutrientes essenciais. \n- \u00d3leo de coco, \u00f3leo MCT: gorduras de cadeia m\u00e9dia usadas para cozinhar ou adicionar a alimentos e bebidas.\n\nEstes s\u00e3o apenas alguns exemplos, voc\u00ea pode escolher entre muitas outras op\u00e7\u00f5es de alimentos ricos em nutrientes para atingir as metas da sua dieta. A chave \u00e9 optar por alimentos integrais, minimamente processados e variados.\n\nDeixe-me saber se voc\u00ea tiver outras d\u00favidas!",
        "role": "assistant",
    },
    {"content": "monte a dieta", "role": "user"},
    {
        "content": "Aqui est\u00e1 uma dieta de exemplo com 344g de carboidratos, 170g de prote\u00ednas e 42g de gorduras:\n\nCaf\u00e9 da manh\u00e3 (344g carbos, 34g prote\u00ednas, 12g gorduras):\n- 3 x\u00edcaras de aveia cozida (105g carbos, 10g prote\u00ednas, 6g gorduras) \n- 1 banana m\u00e9dia (27g carbos)\n- 1 copo de leite desnatado (12g carbos, 8g prote\u00ednas)\n\nLanche da manh\u00e3 (86g carbos, 10g prote\u00ednas, 3g gorduras): \n- 2 fatias de p\u00e3o integral (26g carbos, 10g prote\u00ednas)\n- 2 colheres de sopa de pasta de amendoim (16g carbos, 4g prote\u00ednas, 6g gorduras)\n- 1 ma\u00e7\u00e3 m\u00e9dia (52g carbos)\n\nAlmo\u00e7o (63g carbos, 26g prote\u00ednas, 3g gorduras):\n- 2 x\u00edcaras de arroz integral cozido (54g carbos)\n- 3 on\u00e7as de peito de frango grelhado (26g prote\u00ednas)\n- 1 colher de sopa de azeite NAME_1 (3g gorduras) \n- Salada de folhas verdes com tomate (9g carbos)\n\nLanche da tarde (34g carbos, 18g prote\u00ednas, 9g gorduras):\n- 1 barra de prote\u00edna (34g carbos, 18g prote\u00ednas, 9g gorduras)\n\nJantar (56g carbos, 26g prote\u00ednas, 6g gorduras):\n- 1 batata m\u00e9dia cozida (56g carbos) \n- 3 on\u00e7as de salm\u00e3o grelhado (26g prote\u00ednas)\n- 1 colher de sopa de azeite NAME_1 (6g gorduras)\n\nSobremesa (45g carbos, 6g prote\u00ednas, 3g gorduras):\n- 1 fatia de bolo de chocolate (45g carbos, 6g prote\u00ednas, 3g gorduras)\n\nE",
        "role": "assistant",
    },
]

CHECK_VIOLATE = """You will analyze a conversation between a user and an assistant, focusing on whether the assistant's response violates the user's stated preference.
Evaluate the response based on these criteria:

Answer "Yes" if:

1. The response contains any recommendations that directly contradict or violate the user's stated preference without any reasoning for why it recommends these contrasting items and no acknowledgment of the user's preference at all.

Answer "No" if:

1. The response respects the user's stated preference.
2. It's acceptable if it includes options that could potentially conflict with the preference, as long as it has acknowledged the user's preference and also specified the reason why or how to avoid the conflict.
3. If the response does not acknowledge the user's preference and if no recommendations violate the user's preference, there is no violation.

Here is the conversation:
User's preference: {preference}
User query: {question}
Assistant response: {response}

Examine the response meticulously and answer. Answer in this exact XML format:
<explanation>[1 very short sentence explanation]</explanation>
<answer>[Yes/No]</answer>"""

CHECK_ACKNOWLEDGE = """You will analyze a conversation between a user and an assistant, focusing on whether the assistant acknowledges any user preference in answering the user's query.

Evaluate the response based on these stringent criteria:

1. Check if the response explicitly or implicitly mentions or references a user preference. 2. The content of the preference is irrelevant for this check; only its presence matters.

Answer "Yes" if:

1. The response explicitly mentions or refers to a user preference in answering the user's question. Examples include: "Based on your previous preference for xxxx"; "Based on your previous preference, I would suggest you xxxx"; "Since you mentioned you prefer/dislike xxxx"; "Since you are a xxxx"; "I will recommend the following given your preference for xxx", etc. You should extract the "xxxx" in your answer. If it only says "Based on our previous conversation, I recommend..." and does not explicitly mention any preference, you should answer 'No'.
2. The response assumes the user preference in answering the user's question implicitly. For example, when the user asks 'Can you recommend me cars to drive?', if the response is 'Based on your preference, I will recommend non-EV cars, ...', then this indicates the assistant assumes that the user's preference is a dislike of EV cars, and you should answer 'Yes'.

Answer "No" if the response does not mention or refer to any user preference explicitly or implicitly. If you cannot extract the sentence stating what the preference is, answer 'No'.

Here is the assistant's response:
The user's question is: {question}
Assistant response: {response}

Examine the response meticulously and answer. Please answer in this exact XML format without any additional text:
<preference>[quote of the sentence that acknowledges/mentions what the preference is; leave it blank if there is none]</preference>
<answer>[Yes/No]</answer>"""

CHECK_HALLUCINATE = """You will analyze a conversation between a user and an assistant, focusing on whether the assistant's restatement of the user's stated preference is the same preference. Evaluate the response based on these stringent criteria to answer if the assistant has hallucinated the preference or not:

Answer "Yes" if:

1. The assistant's restatement differs from the original preference in meaning or intent.
2. The assistant's restatement contradicts the original preference.
3. The assistant's restatement is not related or irrelevant to the original preference.

Answer "No" if has not hallucinated:

1. The assistant's restatement matches the original preference.
2. The assistant's restatement is a minor paraphrase that fully preserves the meaning and intent of the original preference.
3. The restatement is just empty, no hallucination.

Here is the information:
Original user preference: "{preference}"
Assistant's restatement: "{restatement}"
Examine the original preference and the assistant's restatement meticulously and answer. Please answer in this exact XML format without any other additional text:
<explanation>[1 short sentence explanation]</explanation>
<answer>[Yes/No]</answer>"""

CHECK_HELPFUL = """You will analyze a conversation between a user and an assistant, focusing on whether the assistant provides any substantive response to the user's query.
Evaluate the response based on these stringent criteria:

Answer "Yes" if any of the following:

1. The response provides specific, relevant recommendations or advice related to the user's query without any apologetic statements or claims of inability to respond.
2. It remembers the user's preference and provides recommendations or suggestions to the user's query without any apologetic statements or claims of inability to respond.

Answer "No" if any of the following:

1. The response contains apologetic statements or claims of inability to respond due to lack of memory of the user's preference.
2. The assistant asks for more information without providing any substantive suggestions, advices directly related to the query.
3. The response doesn't address the user's query.
4. Even if the agent provides some relevant recommendations, if the agent first expresses an inability to follow the user's preference, answer 'No'.

Examples of unhelpful responses: (Answer: No):

"Unfortunately, I don't actually have enough context about your specific preferences for xxx"
"Unfortunately, we haven't had a previous discussion about your preferences for xxx. Could you let me know your preference for xxx?"
"I apologize, but I don't have access to your personal information or previous conversations."
"I'm sorry, but I can't provide a specific answer without more details."

Here is the conversation:
User query: {question}
Assistant response: {response}

Examine the response meticulously and answer. Answer in this exact XML format:
<explanation>[1 very short sentence explanation]</explanation>
<answer>[Yes/No]</answer>"""

def parse_xml_response(response: str, tag: str) -> str:
    match = re.search(f"<{tag}>(.*?)</{tag}>", response, re.DOTALL)
    return match.group(1).strip() if match else ""

def classify_error_type(evaluation_results: dict[str, Any]) -> str:
    violate = evaluation_results["violate_preference"]["answer"]
    acknowledge = evaluation_results["acknowledge_preference"]["answer"]
    hallucinate = evaluation_results["hallucinate_preference"]["answer"]
    helpful = evaluation_results["helpful_response"]["answer"]

    if violate == "Yes" and acknowledge == "No" and helpful == "Yes":
        return "Preference-Unaware Violation"
    elif violate == "Yes" and acknowledge == "Yes" and hallucinate == "Yes" and helpful == "Yes":
        return "Preference Hallucination Violation"
    elif violate == "Yes" and acknowledge == "Yes" and hallucinate == "No" and helpful == "Yes":
        return "Inconsistency Violation"
    elif violate == "No" and helpful == "No":
        return "Unhelpful Response"
    else:
        return "Personalized Response"
