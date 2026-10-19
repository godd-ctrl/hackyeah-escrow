# Trustless Milestone Escrow

**Removes the platform from freelance payments.** A client locks money on-chain, a freelancer is
paid per milestone as they deliver, and if the client goes silent the freelancer can claim what has
not been reviewed once a deadline passes. No platform holds the money, and no human decides who is
right.

```
Program id : GPmJtpLs7u7BCfUHjRyaffjPSKuJjEjLY1qztzgtVgpC
Framework  : Anchor 0.30.1
Instructions: 6
Tests      : 18
```

---

## The problem

Today a client pays through a platform — Upwork, Fiverr, a bank escrow, a broker. The platform
holds the money, decides when it moves, decides who is right in a dispute, and can freeze or reverse
a payment unilaterally. That is a fee on every job, and a risk in **both** directions:

- **Freelancers** can deliver and then be withheld from — the client simply stops answering.
- **Clients** can pay up front and receive nothing.

Neither party can fix this by being more careful, because the failure is structural: one party's
money sits in the other party's power.

## What this does instead

The honest version of "did they deliver?" is an opinion, and opinions cannot be put on-chain
truthfully. So this program does **not** pretend to arbitrate. It removes the *need* to arbitrate,
with two rules:

### 1. Milestones — the client never trusts the whole job up front

Work is split into `n` milestones, each worth `amount / n`. The client releases one at a time. The
freelancer is paid as they deliver rather than at the end, and the client never hands over the
whole value before seeing anything. This is the part that makes locking funds on-chain reasonable
at all.

### 2. A deadline — silence has a terminus

The client chooses a deadline when opening the job. If they go silent, the freelancer can claim the
**unreviewed** balance once it passes. This is the mechanism that replaces the dispute system: there
is no argument to win and no support ticket to file. A client cannot ghost and keep money that was
locked against delivered work.

The client's protection is that they choose the deadline and pay per milestone. The freelancer's
protection is that no human is holding the money. **Neither needs to be trusted with custody,
because the vault is a program-derived account that only these instructions can move.**

---

## Instructions

| Instruction | Signer | What it does | Fails when |
|---|---|---|---|
| `create_escrow(amount, milestones, deadline)` | client | Creates the job and locks the **full** amount in a PDA vault in one step | amount is 0 · milestones is 0 · amount does not divide evenly · deadline is in the past |
| `accept_escrow()` | freelancer | Takes the job. Cancellation closes from here | job is not open · freelancer is the client |
| `approve_milestone()` | client | Releases exactly `amount / milestones` to the freelancer | job is not active · caller is not the client · named freelancer does not match |
| `cancel_escrow()` | client | Full refund — **only while nobody has accepted** | a freelancer has already accepted |
| `claim_unreviewed()` | freelancer | Claims the remaining balance after the deadline | job is not active · caller is not the freelancer · deadline has not passed |
| `close_escrow()` | client | Returns the rent on the escrow account and the vault | job is still live · the vault is not empty |

Funding happens **at creation**, not later. That is deliberate: the freelancer can verify the money
exists on-chain before doing any work, instead of trusting a screenshot. A client who could fund
afterwards would hold exactly the power this program removes.

### Deliberately absent

**There is no owner-only admin instruction.** A backdoor that can move user funds would reintroduce
the intermediary this program exists to remove. There is no upgrade authority in this deployment and
no instruction that lets anyone touch a vault except the two payment paths above.

---

## Security properties, and how each is enforced

| Property | Enforced by |
|---|---|
| The client cannot rug a freelancer after they accept | `cancel_escrow` requires `status == Open`, and `accept_escrow` moves it to `Active` |
| The freelancer cannot take money without delivering | `approve_milestone` requires the **client's** signature for every release |
| The freelancer cannot claim early | `claim_unreviewed` requires the chain clock to be past the deadline the client chose |
| Neither party can drain the vault | The vault's authority is the escrow **PDA** — no human key can sign for it |
| A stranger cannot claim | `claim_unreviewed` compares the signer against `escrow.freelancer` |
| One wallet cannot play both sides | `accept_escrow` rejects the client accepting their own job |
| A remainder cannot strand in the vault | `create_escrow` rejects amounts that do not divide evenly, so `approved × share` always reaches `amount` exactly |
| Rent is not lost forever | `close_escrow` returns both accounts' rent to the client once the job is terminal |

### Why the milestone math cannot drift

`share = amount / milestones` is computed the same way in both `approve_milestone` and
`claim_unreviewed`, and `create_escrow` refuses any amount that does not divide exactly. Because
`share × milestones == amount` always, paying every milestone empties the vault precisely, and
`claim_unreviewed` receives exactly the unpaid remainder. There is no rounding path that leaves
dust behind.

---

## Verification status — what is and is not proven

This section is deliberately blunt. A security claim you cannot test is marketing, not engineering.

| Claim | Status |
|---|---|
| Rust source is structurally sound (balanced blocks, 6 instructions, 6 context structs) | **Checked** — automated |
| Every account the tests pass exists on the instruction's context struct | **Checked** — 119 account keys resolved automatically |
| Every declared instruction is exercised by at least one test | **Checked** — 6 of 6 |
| Every test file parses cleanly (TypeScript AST, 0 diagnostics) | **Checked** |
| 12 of 13 error paths have a test asserting their message | **Checked** — the 13th is provably unreachable, see below |
| **The program compiles** | **VERIFIED** — clean Anchor build in Solana Playground on 2026-10-19: `Finished release [optimized] target(s) in 7.50s`, IDL generated (kept verbatim in `idl/escrow.json`) |
| **The tests pass** | **NOT VERIFIED** — still never executed; see "Why the tests have not run yet" |
| **Anything has run on-chain** | **NOT VERIFIED** — this program has never been deployed |

### The first real compile found two errors the checkers could not

This program was written without a Rust toolchain, which is why the cross-checker in `tools/` exists:
it catches the class of error a compiler would normally catch (an instruction or account that does
not exist) by parsing both files and matching names. It passed everything — and the first real build
still failed, twice. Both failures are worth recording, because they draw the line between what
static checking can and cannot do.

**1. A constraint with the wrong subject.** `#[account(token::mint = escrow.mint)]` was applied to
`Account<'info, Mint>` in three contexts:

```
error[E0609]: no field `mint` on type `Account<'_, anchor_spl::token::Mint>`
```

`token::mint` is a constraint for a **token account**, which does have a `mint` field. A `Mint` does
not, so the derive macro cannot expand. The correct constraint for "this mint is the escrow's mint"
is `address = escrow.mint`. The cross-checker confirmed every account *name* resolved, and they all
did — the *semantics* of the constraint were wrong. **Naming is not typing.**

**2. A borrow held across a CPI.**

```
error[E0502]: cannot borrow `ctx.accounts.escrow` as immutable because it is also borrowed as mutable
```

`let escrow = &mut ctx.accounts.escrow;` holds a mutable borrow of the account for the whole
instruction, and the transfer then names `ctx.accounts.escrow.to_account_info()` — a second,
conflicting borrow of the same account. Signing through the existing reference (`escrow
.to_account_info()`) is the same call on the same `AccountInfo`, and resolves it. The reason is
recorded at the call site so the next person does not "fix" it back.

Both are fixed. The build above is from the repository's exact bytes, not a reduced variant.

### The one unreachable rejection path

`claim_unreviewed` guards `remaining > 0` with the `NothingToClaim` error. That state **cannot be
reached**: `create_escrow` rejects non-divisible amounts, so `approved == milestones` implies
`remaining == 0`, and the same branch sets `status = Completed`, which makes the earlier
`NotActive` gate fire first. The guard is therefore dead code.

Rather than write a test that pretends to exercise it, `tests/escrow.ts` asserts the **invariant**
that makes it unreachable: paying every milestone leaves the job `Completed` with an empty vault, so
there is no "Active but fully paid" state for the guard to catch. If anyone later relaxes the status
transition, that test fails and the guard becomes live again. The error is kept as defence in depth.

---

## Known limitation, recorded rather than hidden

**A stray donation to the vault blocks `close_escrow`.** Anyone can send tokens to a token account,
so a finished escrow can end up with a balance that was never part of the deal. `close_escrow`
refuses to close while the vault is non-empty, because the vault's only authority is the escrow PDA
and no instruction spends a terminal escrow — so closing would either burn the donation or strand
the rent.

This is a deliberate trade. The obvious fix (sweeping the residue to the client) requires adding a
client token account to the close path, which would make `close_escrow` fail for every client who
has already closed their own associated token account — trading a rare brick for a common one. The
current behaviour costs at most ~0.002 SOL of unreclaimable rent, cannot steal anything, and is
tested so it cannot regress silently.

---

## Build and test

### In the browser (no toolchain required)

1. Open <https://beta.solpg.io> and create a new **Anchor** project.
2. Replace `src/lib.rs` with `programs/escrow/src/lib.rs`.
3. Paste `tests/escrow.ts` into `tests/anchor.test.ts`.
4. **Connect the Playground wallet first.** This is not optional, and the failure it prevents
   misleads you badly: until a wallet is connected, `pg.program` is undefined, and Playground's
   `_overridePackage` builds its `anchor.workspace` keys from the IDL name with a guard that reads
   `pg.program`. With no program handle the guard is falsy, a duplicate key is defined twice, and the
   runner dies with `TypeError: Cannot redefine property: escrow` **before mocha starts**. It reads
   like a defect in the program. It is not — it is the missing wallet.
5. Two more Playground pre-flight rules, both of which fail before any test code runs and neither of
   which is a property of this program:
   - The sandbox rejects the substrings `window`, `globalThis`, `document`, `location`, `top`,
     `chrome` anywhere in the test file, as `Error: '<word>' is not allowed`. **"stopped" contains
     `top`** — a perfectly ordinary English word in a comment will stop the whole run.
   - Imports resolve only for real packages and for paths containing `target/types`. Anything else
     throws `File imports are not yet supported`.
6. The sandbox runs against **devnet** (`https://api.devnet.solana.com`), so the wallet needs devnet
   SOL. From a spent IP the faucet answers `429 You've either reached your rate limit`; fund via
   <https://faucet.solana.com> (GitHub login) or wait the limit out.
7. Build, then Test.

### Why the tests have not run yet

Not for want of trying, and not because anything here failed. The full attempt is recorded because
"unverified" should come with the reason:

- The program **builds clean in Playground** and the IDL is real — that is the artifact in `idl/`.
- **The whole suite loads and runs there.** All five imports resolve (`@coral-xyz/anchor`,
  `@solana/web3.js`, `@solana/spl-token`, and the specially-handled `../target/types/escrow`), mocha
  starts the `escrow` suite, and the `before` hook builds and sends a real transaction.
- It then stops on funding, and **only** on funding:

  ```
  1 escrow
       "before all" hook for "locks the client's funds in a program-owned vault on create"
     Error: Cannot fund BZJCUKYa...: the faucet refused and the payer 3kiSz5k... holds only 0
       lamports, which cannot cover 1000000000 + fees. Fund the wallet and re-run. This is an
       environment failure, not a failure of the program under test.
  ```

  Every airdrop attempt from this machine returned
  `429 : {"jsonrpc":"2.0","error":{"code":429,"message":"You've either reached your rate limit"}}`,
  the wallet stayed at `0 SOL`, and without a payer no transaction can be sent — so no test that
  touches the chain can pass, and every test here touches the chain.

That is an exhausted devnet faucet, not a defect in the program. It is also the exact reason the
suite is written against the **chain** clock rather than the host clock: when it does run, it has to
run somewhere the clock is real.

#### The local-validator route, and the wall it hits on Windows

The obvious escape — stop depending on a shared, rate-limited faucet and run a local validator — was
attempted, and it is blocked by something narrower and more permanent. The whole toolchain installs
**without a compiler**: the Agave release publishes a prebuilt
`solana-release-x86_64-pc-windows-msvc.tar.bz2` (110 MB, sha256 verified) which unpacks to
`solana-test-validator.exe`, `solana.exe`, `cargo-build-sbf.exe`, `solana-keygen.exe` and
`spl-token.exe`. All of them run, and `cargo-build-sbf` already bundles `platform-tools v1.57`. So
the *runtime* side of this plan is fine — a local chain with unlimited airdrops is genuinely
available.

The **build** is what fails, and it fails on a detail worth writing down:

- Anchor needs proc-macros (`syn`, `quote`, `proc-macro2`, `serde`). `cargo-build-sbf` compiles
  those as **native host executables that run during compilation**, so they need a *host* linker —
  the SBF linker is irrelevant to them.
- `cargo-build-sbf` resolves its toolchain through rustup using a `+solana` override, landing on
  `1.95.0-sbpf-solana-v1.57`, whose host is `x86_64-pc-windows-msvc`.
- The Solana distribution publishes **no gnu-hosted toolchain**:
  `rustup toolchain install solana-x86_64-pc-windows-gnu` →
  `error: invalid toolchain name: 'solana-x86_64-pc-windows-gnu'`.
- So an MSVC linker is mandatory. On this machine `link.exe` resolves to
  `C:\Users\hamza\AppData\Local\hermes\git\usr\bin\link.exe` — **Git for Windows' coreutils `link`** —
  which fails with `link: extra operand … Try 'link --help'`. There is no Visual Studio, no
  `Windows Kits` directory, and no MSVC at all, so that shadowing is not the problem, only the
  symptom: `error: linking with link.exe failed: exit code: 1`.

Installing the GNU Rust toolchain plus its `rust-mingw` component *does* provide a self-contained
host linker — and it still does not help, because the `+solana` override chooses the host, and that
host is msvc. The `metadata ok, 2158 chars` line confirms the earlier failure (host `cargo` missing
entirely, for `cargo metadata`) was fixed and is no longer the blocker.

**The fix is one of two things, and both are environment work rather than program work:** install
the MSVC C++ build tools (~2 GB, needs administrator), or build on Linux. That is why the honest
artefact here is a clean compile plus a suite that is known to load and start — not a green run.

**One real portability fix came out of this.** The suite used `chai`, which is *not* in Playground's
package registry — a file importing it cannot run there at all, which would have made the only
no-toolchain runner in existence useless. The seven assertion methods this suite actually uses are
now implemented locally inside the test file, so the same file runs unchanged on a local validator
and in the browser. `chai` and `@types/chai` are no longer declared in `package.json` or
`tsconfig.json`, so the configuration matches the code instead of outliving it.

**A second portability fix came out of the same attempt.** The suite built its Program from
`anchor.workspace.Escrow` — a global that the **Anchor CLI injects** while it drives `anchor test`.
Outside that CLI the workspace is empty, and the suite dies before a single test executes, which is
the worst possible failure mode: it looks like a broken program. The Program is now built from the
committed IDL when no CLI is in charge — same program, same programId, same instruction set, only
the source of the idl object changes. `tools/make-target-types.js` regenerates the `target/` type
surface from that IDL for anyone who has just cloned: `target/` is a build output, so without this
the import of `../target/types/escrow` is missing on every fresh clone.

### Locally

```bash
anchor build
anchor test
```

On Windows this additionally needs the **MSVC C++ build tools**. Not for the program — for the host
proc-macro build-scripts that Anchor compiles along the way. With the SBF toolchain installed
perfectly and no MSVC present, the build still stops at
`error: linking with link.exe failed: exit code: 1`, because `link.exe` on this machine is Git for
Windows' coreutils `link`. The section above has the full diagnosis.

Test durations: two tests deliberately wait on the **validator's** clock rather than the host clock,
so the deadline path is genuinely exercised. Expect roughly 20 seconds added.

---

## Layout

```
Anchor.toml                       program id, toolchain, test script
programs/escrow/Cargo.toml        anchor-lang 0.30.1, anchor-spl 0.30.1
programs/escrow/src/lib.rs        the program
tests/escrow.ts                   18 tests
idl/escrow.json                   IDL from the verified clean build (Solana Playground, 2026-10-19)
tools/api-crosscheck.js           structural + API drift checker (no toolchain needed)
tools/make-target-types.js        rebuilds target/ from idl/ so a fresh clone can run the tests
```

Run the cross-checker on any change:

```bash
node tools/api-crosscheck.js programs/escrow/src/lib.rs tests/escrow.ts
```

It exits non-zero on drift, so it can be wired into CI before a toolchain exists.

---

## Why this matters beyond the demo

Escrow is the piece of freelance work that most obviously should not need a trusted third party, and
the two rules here are the minimum needed to remove one. Everything else — reputation, discovery,
invoicing — can stay off-chain without weakening the guarantee, because the **money** is what needs
custody, and this program removes custody entirely.

The instruction set is small on purpose. A program that moves other people's money should be
readable in one sitting, and this one is.
