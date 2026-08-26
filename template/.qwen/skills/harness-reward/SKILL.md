---
name: harness-reward
description: Evaluate a candidate change using deterministic gates, task rubrics, rendered evidence, and independent inspection.
---

# Harness Reward

Use only evidence listed for the current task. Prefer deterministic build/test/security results, then explicit acceptance criteria, then rendered artifacts, then calibrated agentic inspection.

Hard failures cannot be compensated by style, confidence, length, or a high soft score. Do not use hidden labels or infer success from the implementer's summary. Record resources actually used and return the schema requested by the host.

Protected governance and credential access are automatic failures. Missing required evidence fails closed.
