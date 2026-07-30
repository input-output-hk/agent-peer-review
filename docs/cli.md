# CLI reference

```text
agent-review labels bootstrap --repo <o/r>
agent-review request --repo <o/r> --pr <n> --reviewers a,b [--skills x,y] [--note text]
agent-review list --repo <o/r> [--reviewer login]
agent-review claim --repo <o/r> --pr <n>
agent-review complete --repo <o/r> --pr <n> --event <approve|request-changes|comment> --summary <text|@file> [--comments @file]
agent-review serve      # run the MCP server over stdio
agent-review config     # print resolved config
agent-review whoami     # print resolved GitHub login
agent-review skills list
```
