# Architecture Review

Ground checks in established design principles: information hiding (Parnas), coupling and cohesion, SOLID, and Robert Martin's package-design principles (Acyclic Dependencies, Stable Dependencies, Stable Abstractions).

- **Module boundaries and responsibilities:** each module should hide one design decision or own one responsibility; flag a diff that gives a module a second, unrelated responsibility, or that duplicates a responsibility another module already owns.
- **Coupling versus cohesion:** favor high cohesion inside a module and low coupling between modules; flag a change that reaches into another module's internals or private state, or a single logical change that touches many unrelated files because responsibilities are smeared across them.
- **Dependency direction:** dependencies should point from volatile code toward stable code (Stable Dependencies Principle) and never form a cycle (Acyclic Dependencies Principle); flag a new import that makes a lower-level or more-stable module depend on a higher-level or more-volatile one, or two modules that depend on each other directly or transitively.
- **Separation of concerns:** business logic, I/O, and presentation belong in distinct layers; flag a diff that mixes network or database calls into domain logic, or view code that makes business decisions, since either makes the other hard to reuse or test in isolation.
- **YAGNI and premature abstraction:** add an interface, plugin point, or configuration flag only when a second concrete need exists now; flag speculative generality, unused extension points, or a factory/strategy standing in for a single implementation with no second caller in sight.
- **Change locality:** a well-scoped change should touch a small, predictable set of files; if a small fix or feature ripples across many unrelated modules, the boundary is likely wrong even when each individual edit is correct in isolation.
- **Testability and seams:** code needs seams, places where a collaborator can be substituted in a test without editing the code under test (constructor/parameter injection, interfaces at I/O boundaries); flag new code that constructs its own collaborators inline, reaches for global or static state, or otherwise cannot be exercised without the real dependency.
- **Clear interfaces:** a module's public surface should express intent, not leak implementation; flag an interface that exposes internal types, requires callers to know a specific call order, or that changed in a way that breaks callers silently at runtime instead of at compile or type-check time.

For public-surface contract concerns (versioning, backward compatibility, error contracts), see the `api` skill.
