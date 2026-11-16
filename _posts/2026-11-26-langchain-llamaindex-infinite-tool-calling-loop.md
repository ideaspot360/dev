---
layout: post
title: "Preventing Infinite Tool-Calling Loops & Runaway Cost Spikes in LLM Autonomous Agents"
date: 2026-11-26 12:49:00 +0900
category: "AI & Machine Learning"
tags: ['LangChain', 'LLM', 'Agents', 'ToolCalling', 'Reliability', 'CostOptimization']
---

## Production Incident Summary

Over a 4-hour weekend window, an automated customer support agent built on LangGraph and GPT-4o executed over 120,000 tool invocations on an ambiguous user prompt:

```text
[CRITICAL] Agent Execution Alert:
Session ID: sess_984f2910a
Duration: 3h 48m 12s
Total Iterations: 1,482
Tool Calls:
  - query_gmail_receipts: 741 calls
  - append_google_sheet: 741 calls
OpenAI API Cost: $1,842.60 (Single Session Spike)
Status: Throttled by OpenAI 429 RateLimitError (TPM Exceeded)
```

---

## 1. Root Cause: Non-Deterministic Stopping & Missing Idempotency

Autonomous agents driven by ReAct (Reason + Act) loops evaluate tool execution outputs to decide whether the user goal is satisfied.

1. **Weak Stop Conditions**: The prompt relied solely on the LLM's internal judgment to emit a `Final Answer`. When tool returns contained minor noise, the LLM hallucinated that further verification was required.
2. **Lack of Loop Breakers**: The agent runner lacked hard recursion limits (`max_iterations`) and timeout controls at the execution graph layer.
3. **Non-Idempotent Tools**: The `append_google_sheet` tool lacked deduplication keys, appending duplicate rows 741 times without failing.

---

## 2. Production Fix: Deterministic Guardrails & LangGraph Circuit Breakers

```python
from langgraph.checkpoint.memory import MemorySaver
from langgraph.prebuilt import create_react_agent

app = create_react_agent(model=llm, tools=tools, checkpointer=MemorySaver())

config = {
    "configurable": {"thread_id": "session_user_42"},
    "recursion_limit": 15  # Hard circuit breaker: aborts on 15th iteration
}

try:
    for event in app.stream({"messages": [("user", prompt)]}, config=config):
        print(event)
except Exception as e:
    fallback_to_human_agent(session_id="session_user_42", reason=str(e))
```

Pair this with an SHA-256 idempotency cache inside mutation tools to guarantee that repeating an identical action immediately returns a stopping directive.
