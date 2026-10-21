# Video script — 3 minutes, one take is enough

The listing asks for **≤ 3 minutes**. This is written for the shortest version that still proves the point,
because a recording session that needs a script rewrite never happens.

## Before you hit record

1. **Two browser profiles** (or one normal window + one incognito). A wagering flow needs two separate
   wallets — one client, one freelancer — and switching accounts in one profile mid-take is where takes die.
2. Both wallets on **devnet**, both funded. Fund them the day before; the faucet rate-limits by IP and it
   will choose the worst possible moment.
3. In the app's **Setup** card, press **Create demo money** in *both* profiles. That mints a 6-decimal token
   and funds each wallet, so the demo never depends on a faucet mid-take.
4. **Set the deadline to 2 minutes**, not 10. The last beat of the video is the deadline branch, and you do
   not want to sit in silence waiting for it.
5. Have `tools/app-check.js` and `tools/app-keycheck.js` already run once, so the terminal scrollback is
   there to film. Running them live is fine too — they finish in about two seconds.

## Beats

### 0:00 – 0:20 · The problem

> "Two people who have never met need someone to hold the money. Today that someone is a platform: it takes
> a cut, decides disputes by reading messages, and can freeze either account. This removes it."

Show: the problem slide from the deck, or just talk over the app's landing page.

### 0:20 – 0:50 · The mechanism

> "Four instructions. The client locks the whole job in a vault that only the program can move. The
> freelancer accepts, which closes the client's refund path. Each approval releases one milestone. And if the
> client goes silent, the deadline pays out the rest."

Show: `programs/escrow/src/lib.rs` — scroll the instruction list. Do not read code aloud; the point is that
it is short enough to scroll.

### 0:50 – 2:00 · The flow, with two wallets

**Client window:**

1. Create demo money (if you did not pre-create it).
2. Amount `300`, milestones `3`, deadline `2` minutes → **Create escrow**.
3. Point at the explorer link: *"that transaction is the money existing."*

**Freelancer window:**

4. Paste the escrow address → **Load**. Point at the vault balance: *"this is what the platform used to
   promise, and now it is a number anyone can read."*
5. **Accept as freelancer.**

**Client window:**

6. **Approve milestone** once. Say the number: *"one third released, two thirds still locked, and neither
   of us can move them."*
7. Try **Cancel** — it is disabled, and say why: *"the work started, so the refund path is closed. That is
   the constraint, not a policy."*

### 2:00 – 2:35 · The part no other app has

> "Now the client stops answering."

Wait for the 2-minute deadline (cut the wait, or set the deadline to 1 minute if you are confident).

**Freelancer window:**

8. Reload → **Claim after deadline**. It succeeds despite the client never approving.

> "No dispute desk, no support ticket. The deadline is the reviewer."

### 2:35 – 2:55 · Why you can trust the code

Show the terminal:

```
node tools/app-check.js
node tools/app-keycheck.js
```

> "The app encodes the instructions itself, so both checkers run against the IDL. The second one executes
> the shipped encoders and compares every account slot to the program — because a swapped key builds a
> transaction that fails with an error nobody can read."

### 2:55 – 3:00 · Close

> "126 bytes of state, no admin key, and the money is the agreement. Repo in the description."

---

## Recording notes

- **Screen + voice only.** No webcam, no music. A judge watching their twelfth submission rewards clarity.
- **Cut the waits.** Two-minute deadline means two minutes of nothing; record the wait, cut it in the edit,
  keep the timestamp visible so it is obvious the branch fired on time.
- **Do not narrate menus.** "Now I'll click the button that says Create escrow" wastes the strongest 60
  seconds you have.
- **If a transaction fails on camera, keep it in.** Say what failed and re-run. A submission whose demo
  breaks and is diagnosed is more credible than one that is suspiciously perfect.
- **File size.** 1080p, under 100 MB, upload unlisted to YouTube or as an MP4 link — the listing only needs
  a URL that plays without a login.
