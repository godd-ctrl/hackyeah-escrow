# Submission copy

Everything here is ready to paste into the listing form. Fill the remaining `TO DO` links once the program is
deployed and the video is recorded.

> **Check this first.** The listing says *"This listing is only open for people in Poland."* If you do not
> hold Polish residence or citizenship, the entry is likely ineligible and no amount of packaging changes
> that. Everything below is still worth having — it is the portfolio a paying client asks for — but do not
> spend a day on the video before checking that one line.

---

## Title

**Milestone Escrow — freelance payments without a platform holding the money**

## One-liner (for link previews / the card)

A milestone escrow on Solana. The client locks the whole job in a vault only the program can move; the
freelancer sees it before starting; if the client goes silent, the deadline releases it.

---

## Description

Paste as markdown:

```markdown
Every freelance job between two strangers needs a third party to hold the money. That third party charges
for the privilege, decides disputes by reading a chat log, and can freeze either account whenever it likes.
The work can be finished and still not be payable.

Milestone Escrow removes the middleman with four instructions and a deadline.

**How it works**

- **Create** — the client moves the full job amount into a vault owned by an escrow PDA. The escrow address
  is derived from `[client, mint, deadline]`, so both sides can verify the money exists before any work
  starts.
- **Accept** — the freelancer binds their key to the escrow. This closes the client's refund path, so they
  cannot take the money back once work has begun.
- **Approve** — each milestone releases `amount / milestones`. Creation rejects an amount that does not
  divide evenly, so the vault can always be emptied and nothing is ever stranded.
- **Claim** — if the client never reviews, the freelancer claims the remaining balance after the deadline.
  This is the instruction that replaces the platform's dispute desk: silence has a terminus.

**Why this is not just "escrow on a chain"**

The deadline branch is what makes it a substitute rather than a tool. Without it, a client who stops
answering keeps the money forever and you still need a platform to complain to.

**What is built**

- An Anchor program (0.30.1): 6 instructions, 1 account of 126 bytes, two PDAs, no admin key and no
  instruction that moves the vault outside a milestone approval or a passed deadline.
- 18 test scenarios covering both refund paths, every rejection, double approval, and claim before and
  after the deadline.
- `app/index.html` — the product, as one file with no build step: connect a wallet, mint demo money, post a
  job, accept it from a second wallet, release milestones, claim after a deadline. Decoded escrow state and
  an explorer link on every action.
- Three checkers that exit non-zero on drift, including one that executes the app's own instruction encoders
  and compares every account slot and signer/writable flag against the IDL. A swapped account key builds a
  perfectly valid transaction that the program rejects unreadably, and no hash check can see it.

**Verification, stated honestly**

The program builds clean and the IDL is real; the app's encoding is verified against that IDL; the page
loads with zero console errors. The 18 tests have not run yet — the suite starts in Solana Playground and
stops on an exhausted devnet faucet — and nothing is deployed at the time of writing. The README lists
exactly what is proven and what is not, because the repo is the thing a reader can check.
```

---

## Target user and rationale (often a separate field)

```markdown
**Target user:** a freelancer taking a first job from a client in another country, and a small client paying
someone they met last week. Neither has a procurement department, a lawyer, or a reason to trust the other.

**The intermediary they use today** holds the balance, decides disputes, and can freeze an account. The fee
is the visible cost; the invisible one is that neither side can verify the other's money exists before work
starts, which is exactly why the platform can charge it.

**What replaces it:** custody becomes a vault owned by a PDA, so no instruction can move it without an
approval or a passed deadline. Discretion becomes a timestamp. Permission becomes a wallet — no account, no
country check, no reputation threshold. Each of those is a constraint in the program rather than a policy in
a terms-of-service document, and all of it is 126 bytes a reader can inspect.
```

---

## Links

| Field | Value |
|---|---|
| Repo | <https://github.com/godd-ctrl/hackyeah-escrow> — public, 20 files, no keypairs tracked |
| Live demo | `TO DO — deployed app URL (or "run locally: see README")` |
| Video | `TO DO — ≤3 min, script in VIDEO-SCRIPT.md` |
| Deck | `submission/deck.pdf` — 10 pages, already rendered (source: `deck.html`) |
| Program (devnet) | `TO DO` once `anchor deploy` has run |

---

## Pre-submit checklist

- [ ] **Confirm the Poland eligibility rule** before spending time on the video.
- [ ] `anchor build && anchor deploy --provider.cluster devnet` (or deploy via Playground) — this turns the
      one "NOT YET" on deck slide 7 into a proven row, which is worth more than any wording change.
- [x] **Repo is public:** <https://github.com/godd-ctrl/hackyeah-escrow>. `.gitignore` excluded `target/` and
      `node_modules/`; the remote tree was listed to confirm 20 expected blobs, and the only JSON files are
      `idl/escrow.json`, `package.json` and `tsconfig.json` — no keypair, no `.env`, no credential.
- [ ] Record the video from `VIDEO-SCRIPT.md`.
- [x] **Deck PDF rendered:** `submission/deck.pdf`, 10 pages at 960×540 pt (16:9), verified by counting the
      page objects. Re-render after any edit with:
      `chrome --headless=new --no-pdf-header-footer --print-to-pdf=submission/deck.pdf submission/deck.html`
- [ ] Open the deployed app in a clean browser profile and run the flow once, end to end, before recording.
