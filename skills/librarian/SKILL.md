---
name: librarian
description: Use Librarian's public memory tools to query, add, update, inspect, or maintain the local OKF knowledge bundle without loading the private worker interface.
---

# Librarian routing

Use Librarian when the task needs durable local knowledge rather than temporary
conversation recall or a dormant task skill.

- `memory_query` searches the bundle and may delegate a deeper read.
- `memory_add` proposes or records new knowledge through the configured approval
  policy.
- `memory_update` changes an existing concept or document.
- `memory_status` inspects bundle, cache, hot-memory, and worker state without a
  model call.
- `memory_maintain` runs the supported maintenance operation.

Use `retrieve_skill` instead when the request is asking for instructions or a
specialized capability. Do not search the bundle by reading its files directly;
the public tools preserve its metadata, approval, and transaction behavior.
