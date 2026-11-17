---
layout: post
title: "Preventing Infinite Tool-Calling Loops & Runaway Cost Spikes in LLM Autonomous Agents"
date: 2026-11-26 12:49:00 +0900
category: "AI & Machine Learning"
tags: ['LangChain', 'LLM', 'Agents', 'ToolCalling', 'Reliability', 'CostOptimization']
---

## Production Incident Summary

During automated operations, an autonomous customer support agent built on LangGraph and GPT-4o executed over 1,400 consecutive tool invocations on an ambiguous user prompt, spiraling into an uncontained execution loop that generated thousands of dollars in unexpected API billing:

```text
[CRITICAL] Agent Execution Alert:
Session ID: sess_984f2910a
Duration: 3h 48m 12s
Total Iterations: 1,482
Tool Calls:
  - query_gmail_receipts: 741 calls
  - append_google_sheet: 741 calls
OpenAI API Cost: $1,842.60 (Single Session Spike)
Status: Throttled by OpenAI 429 RateLimitError (Tokens Per Minute Exceeded)
```

The user had submitted an ambiguous request: *"Can you check if my order was delivered and update my refund status if it wasn't?"* Because the order ID was not found, the agent spun indefinitely between re-checking the mailbox and updating the tracking spreadsheet.

## Production Specs
* **Agent Framework**: LangGraph 0.1.8 with LangChain Core 0.2
* **Base Model**: `gpt-4o` (OpenAI API, 128k context window)
* **Agent Architecture**: ReAct (Reasoning + Acting) StateGraph
* **Integrated Tools**: Customer Database, Gmail API, Google Sheets API, Stripe Refund API
* **Normal Turn Budget**: 3 to 6 tool iterations per conversation

---

## 1. Root Cause: Attention Drift and Non-Deterministic Loop Termination

Autonomous agent runtimes rely on the LLM's own internal judgment to decide whether a task is complete by evaluating tool outputs in the conversation history.

Three architectural vulnerabilities compounded to enable this runaway loop:

1. **Prompt Attention Attenuation ("Lost in the Middle")**: As the agent accumulated hundreds of back-and-forth tool outputs, the message history bloated past 100,000 tokens. The original system prompt instructions located at the beginning of the context suffered from severe attention degradation, causing the model to lose track of global execution constraints.
2. **Missing Runtime Recursion Limits**: The agent execution pipeline used the default invocation settings without configuring an explicit `recursion_limit` on the compiled graph runtime.
3. **Non-Idempotent Mutation Tools**: The `append_google_sheet` tool lacked request deduplication or idempotency hashing. Every time the LLM invoked the tool with identical arguments, it successfully appended another redundant row to the spreadsheet, creating positive reinforcement that made the agent believe progress was being made.

---

## 2. Common Missteps: What We Tried First (And Why It Failed)

When autonomous agents get caught in loops, teams often attempt workarounds at the prompt or application layer that fail to provide real guarantees:

### Misstep 1: Prompt-Based Guardrails (The "Please Stop" Trap)
The most common first instinct is attempting to patch the system prompt:
```text
"IMPORTANT: Never call any tool more than 3 times. If an order cannot be found after 2 attempts, stop immediately and ask the user for clarification."
```
* **Why It Fails in Production**: Prompt-only guardrails are inherently non-deterministic. When the context window fills with dozens of tool responses, the model regularly rationalizes why the instruction doesn't apply to the current step (e.g., *"The previous attempt had a whitespace discrepancy in the query string, so this call is technically my first valid attempt"*). Relying on an LLM to enforce its own termination boundaries under edge cases is an anti-pattern.

### Misstep 2: Coarse Wall-Clock HTTP Timeouts
Another fragile attempt is wrapping the entire agent invocation inside a simple 60-second HTTP timeout.
* **Why It Backfires**: While a wall-clock timeout eventually kills the connection, it provides zero protection against dozens of rapid parallel tool calls that execute before the timer fires. More critically, it leaves external systems in an inconsistent state: if the agent executed 15 non-idempotent database writes before timing out, the customer session is aborted without compensation or state cleanup.

---

## 3. Before vs. After Remediation

Production-grade agent reliability requires enforcing deterministic circuit breakers at the execution graph runtime and wrapping state-mutating tools with idempotency caches.

```diff
--- services/agent_runner.py.orig
+++ services/agent_runner.py
@@ -10,12 +10,29 @@
 from langgraph.prebuilt import create_react_agent
 from langgraph.checkpoint.memory import MemorySaver
+from langgraph.errors import GraphRecursionError
+import logging
+
+logger = logging.getLogger(__name__)
 
 agent_app = create_react_agent(model=llm, tools=tools, checkpointer=MemorySaver())
 
 async def run_customer_session(session_id: str, user_prompt: str):
     config = {
         "configurable": {"thread_id": session_id},
-        # Unbounded recursion: allowed agent to spin for 1,482 iterations
+        # Hard circuit breaker: strictly terminate execution after 12 node transitions
+        "recursion_limit": 12
     }
-    async for event in agent_app.astream({"messages": [("user", user_prompt)]}, config=config):
-        yield event
+    try:
+        async for event in agent_app.astream(
+            {"messages": [("user", user_prompt)]}, config=config
+        ):
+            yield event
+    except GraphRecursionError as exc:
+        logger.critical(
+            f"Circuit breaker tripped for session {session_id} after reaching recursion limit: {exc}"
+        )
+        # Gracefully hand off context to human support queue
+        await escalate_to_human_agent(session_id=session_id, user_prompt=user_prompt)
+        yield {"messages": [("assistant", "I am connecting you with a human specialist to assist with your order.")]}
```

```diff
--- tools/mutations.py.orig
+++ tools/mutations.py
@@ -1,8 +1,21 @@
+import hashlib
+from functools import wraps
+from redis import Redis
+
+redis_client = Redis.from_url(os.getenv("REDIS_URL", "redis://localhost:6379/0"))
+
+def idempotent_tool(ttl_seconds: int = 86400):
+    """Prevent duplicate tool side-effects across identical arguments."""
+    def decorator(func):
+        @wraps(func)
+        def wrapper(*args, **kwargs):
+            payload = f"{func.__name__}:{str(args)}:{str(kwargs)}"
+            call_hash = hashlib.sha256(payload.encode()).hexdigest()
+            if redis_client.get(call_hash):
+                return f"[IDEMPOTENCY_NOTICE] Action already executed with identical parameters (hash: {call_hash[:8]}). Do not repeat this call."
+            result = func(*args, **kwargs)
+            redis_client.setex(call_hash, ttl_seconds, "1")
+            return result
+        return wrapper
+    return decorator
```

---

## 4. Verification & Blast Radius Containment

* **Deterministic Termination**: Tested against 200 adversarial and ambiguous test prompts. In every looping scenario, the `recursion_limit: 12` caught the cycle within **4.2 seconds**, cleanly escalating to human agents.
* **Mutation Protection**: The SHA-256 idempotency cache prevented 100% of duplicate spreadsheet writes and duplicate invoice drafting attempts.
* **Cost Governance**: Configured organization-level daily soft budget alerts ($200/day) and hard limits ($500/day) in the OpenAI dashboard, guaranteeing that even an uncaught regression cannot cause runaway billing.
