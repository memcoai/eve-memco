# Agents

`@memco/eve`: Memco Shared Memory as a memory provider for [eve](https://github.com/vercel/eve)
agents. It is a thin layer over the published `@memco/memcoai` SDK: credentials, sessions, tools and
error types are the SDK's; this package maps eve's memory contract (recall, tools, capture, scope)
onto them. The design is `plans/eve-memory-provider.md` in the SDK repository.

## Rules

- **Think before coding.** State assumptions; surface tradeoffs; ask when unclear.
- **Simplicity first.** Minimum code that solves the problem; nothing speculative.
- **Surgical changes.** Touch only what the task needs; match the surrounding style.
- **Test first.** Write the failing test, confirm it fails for the right reason, then implement.
  Tests run on `node:test` with a hand-built eve context and a fake Memco client at the SDK
  boundary; no test dependencies beyond eve itself.
- **Use the Makefile.** `make check` is what CI runs.
- **The eve range is what the provider was validated on.** eve's minor releases can break us, so
  the peer range's upper bound is the newest eve that `make validate` passed on, in both modes.
  Supporting a newer eve is a release of this package. The dev and example versions are that newest
  eve. A change that only touches our own test driver is no reason to hold the range back.
- **Never derive identity from the model.** Tenant and user come from `ctx.session.auth.current`;
  every read and write is partitioned by the locked scope.
- **Derivations are data.** `src/derive.ts` names users and networks in Memco; changing it orphans
  every tenant's memory. Its fixed-vector test must only change with a migration.
