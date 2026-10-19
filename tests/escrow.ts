// Trustless Milestone Escrow — behaviour tests.
//
// These are written to be FALSIFIABLE, not to look good. Every rule the program claims to enforce
// gets a test that FAILS if the rule is removed:
//
//   * the vault is program-owned and cannot be drained by either party
//   * money only moves on the two paths the docs promise (approve, or deadline + silence)
//   * the client cannot rug a freelancer after they accept
//   * the freelancer cannot claim before the deadline the client chose
//   * neither party can close a live job
//
// The deadline tests read the VALIDATOR's clock rather than the host clock. Using the host clock
// would pass locally and fail on a machine whose clock is a few seconds out, which is exactly the
// kind of test that teaches you nothing.
import * as anchor from "@coral-xyz/anchor";
import { Program, BN } from "@coral-xyz/anchor";
import { Escrow } from "../target/types/escrow";
import {
  createMint,
  createAccount,
  mintTo,
  getAccount,
  transfer,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import { Keypair, PublicKey, LAMPORTS_PER_SOL } from "@solana/web3.js";
// ── a local `assert`, because the browser-hosted runner has no `chai` ────────────────────────────
//
// The suite used chai. `chai` is not in Solana Playground's package registry, so a file that imports
// it cannot run there at all - and the browser runner is the one place this project can be executed
// without a Rust toolchain. Implementing the seven methods actually used keeps the tests identical
// on a local validator and in the browser, and removes a dependency from a file whose whole point is
// that it can run anywhere.
//
// `equal` keeps chai's loose comparison deliberately: several assertions compare a BigInt against a
// BigInt literal. Tightening it to `===` here would quietly change what the tests assert, which is
// exactly the kind of silent semantic drift this suite exists to catch.
function show(v: unknown): string {
  try {
    return JSON.stringify(v, (_k, x) => (typeof x === "bigint" ? `${x}n` : x));
  } catch {
    return String(v);
  }
}

/** Structural equality - enough for what this suite compares: objects, arrays, bigints, primitives. */
function deepEq(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a === "bigint" || typeof b === "bigint") {
    try {
      return BigInt(a as never) === BigInt(b as never);
    } catch {
      return false;
    }
  }
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((x, i) => deepEq(x, b[i]));
  }
  if (a && b && typeof a === "object" && typeof b === "object") {
    const ka = Object.keys(a);
    const kb = Object.keys(b);
    if (ka.length !== kb.length) return false;
    return ka.every((k) => deepEq((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]));
  }
  return false;
}

const assert = {
  equal(actual: unknown, expected: unknown, msg?: string): void {
    // eslint-disable-next-line eqeqeq
    if (!(actual == expected)) throw new Error(`${msg ?? "equal"}: expected ${show(expected)}, got ${show(actual)}`);
  },
  deepEqual(actual: unknown, expected: unknown, msg?: string): void {
    if (!deepEq(actual, expected)) {
      throw new Error(`${msg ?? "deepEqual"}: expected ${show(expected)}, got ${show(actual)}`);
    }
  },
  isNull(actual: unknown, msg?: string): void {
    if (actual !== null) throw new Error(`${msg ?? "isNull"}: expected null, got ${show(actual)}`);
  },
  isAbove(actual: number, floor: number, msg?: string): void {
    if (!(actual > floor)) throw new Error(`${msg ?? "isAbove"}: expected > ${floor}, got ${actual}`);
  },
  isAtLeast(actual: number, floor: number, msg?: string): void {
    if (!(actual >= floor)) throw new Error(`${msg ?? "isAtLeast"}: expected >= ${floor}, got ${actual}`);
  },
  include(haystack: string, fragment: string, msg?: string): void {
    if (!String(haystack).includes(fragment)) {
      throw new Error(`${msg ?? "include"}: ${show(fragment)} not found in ${show(haystack)}`);
    }
  },
  fail(msg?: string): void {
    throw new Error(msg ?? "assert.fail");
  },
};

// `function`, not an arrow, so the suite can raise its own timeout: two tests genuinely wait on the
// chain clock rather than faking the deadline, and a browser-hosted runner caps the default at 30s.
// An arrow callback has no `this` to configure, so this is not style.
describe("escrow", function () {
  this.timeout(300000);

  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const program = anchor.workspace.Escrow as Program<Escrow>;
  const connection = provider.connection;
  const client = (provider.wallet as anchor.Wallet).payer;

  let freelancer: Keypair;
  let stranger: Keypair;
  let mint: PublicKey;
  let clientAta: PublicKey;
  let freelancerAta: PublicKey;

  // ── clock helpers: read the chain, never the host ──────────────────────────────────────────────
  async function chainNow(): Promise<number> {
    const slot = await connection.getSlot();
    const t = await connection.getBlockTime(slot);
    return t ?? Math.floor(Date.now() / 1000);
  }

  /** Poll until the validator's clock is past a timestamp. Fails loudly rather than hanging. */
  async function waitPast(deadline: number) {
    for (let i = 0; i < 45; i++) {
      if ((await chainNow()) > deadline) return;
      await new Promise((r) => setTimeout(r, 800));
    }
    throw new Error(`chain clock never passed ${deadline} - cannot test the deadline path`);
  }

  // Distinct deadlines keep the PDAs distinct across tests, so one test cannot silently reuse
  // another's escrow account.
  let seq = 0;
  const nextDeadline = async (offsetSeconds = 3600) =>
    (await chainNow()) + offsetSeconds + seq++;

  const escrowPda = (c: PublicKey, m: PublicKey, deadline: number) =>
    PublicKey.findProgramAddressSync(
      [
        Buffer.from("escrow"),
        c.toBuffer(),
        m.toBuffer(),
        new BN(deadline).toArrayLike(Buffer, "le", 8),
      ],
      program.programId
    )[0];

  const vaultPda = (e: PublicKey) =>
    PublicKey.findProgramAddressSync([Buffer.from("vault"), e.toBuffer()], program.programId)[0];

  const createAccounts = (
    escrow: PublicKey,
    vault: PublicKey,
    clientAtaAddr = clientAta
  ) => ({
    client: client.publicKey,
    escrow,
    mint,
    clientTokenAccount: clientAtaAddr,
    vault,
    tokenProgram: TOKEN_PROGRAM_ID,
    systemProgram: anchor.web3.SystemProgram.programId,
    rent: anchor.web3.SYSVAR_RENT_PUBKEY,
  });

  /** Assert that a promise rejects, and that the failure names the rule that halted it. */
  async function expectFail(p: Promise<unknown>, fragment: string) {
    try {
      await p;
    } catch (e: any) {
      const haystack = `${e?.message ?? ""} ${(e?.logs ?? []).join(" ")} ${JSON.stringify(e?.error ?? {})}`;
      assert.include(
        haystack,
        fragment,
        `failed, but not for the expected reason "${fragment}"`
      );
      return;
    }
    assert.fail(`expected a failure containing "${fragment}", but the call SUCCEEDED`);
  }

  /**
   * Fund a fresh keypair so it can pay its own fees.
   *
   * Airdrop first: on a local validator that always works and is the cheapest way to do it. But a
   * shared devnet RPC rate-limits the faucet hard (`429 You've either reached your rate limit`), and
   * a suite that dies on funding proves nothing about the program. So the fallback is a plain
   * transfer from the client, and the outcome is asserted rather than assumed - a funding failure
   * has to name itself here, instead of surfacing later as a puzzling balance mismatch inside some
   * unrelated test.
   */
  async function fund(kp: Keypair, lamports: number) {
    try {
      const sig = await connection.requestAirdrop(kp.publicKey, lamports);
      await connection.confirmTransaction(sig, "confirmed");
    } catch {
      // faucet refused; fall through to paying from the client
    }

    if ((await connection.getBalance(kp.publicKey)) < lamports / 2) {
      // Fail here, named, rather than letting an unfunded payer surface as a raw simulation error
      // ("Attempt to debit an account but found no record of a prior credit") that reads like a
      // program defect. It is an environment problem and the message should say so.
      const payerBalance = await connection.getBalance(client.publicKey);
      if (payerBalance < lamports + 5000) {
        throw new Error(
          `Cannot fund ${kp.publicKey.toBase58()}: the faucet refused and the payer ` +
            `${client.publicKey.toBase58()} holds only ${payerBalance} lamports, which cannot cover ` +
            `${lamports} + fees. Fund the wallet and re-run. This is an environment failure, not a ` +
            `failure of the program under test.`
        );
      }

      const tx = new anchor.web3.Transaction().add(
        anchor.web3.SystemProgram.transfer({
          fromPubkey: client.publicKey,
          toPubkey: kp.publicKey,
          lamports,
        })
      );
      await anchor.web3.sendAndConfirmTransaction(connection, tx, [client]);
    }

    assert.isAtLeast(
      await connection.getBalance(kp.publicKey),
      lamports / 2,
      `could not fund ${kp.publicKey.toBase58()} - faucet refused and the transfer did not land`
    );
  }

  before(async () => {
    freelancer = Keypair.generate();
    stranger = Keypair.generate();
    // 1 SOL each is ample: the only chain costs in this suite are account rent and fees.
    for (const kp of [freelancer, stranger]) {
      await fund(kp, LAMPORTS_PER_SOL);
    }

    mint = await createMint(connection, client, client.publicKey, null, 6);
    clientAta = await createAccount(connection, client, mint, client.publicKey);
    freelancerAta = await createAccount(connection, client, mint, freelancer.publicKey);
    // 1,000.000000 tokens for the client to escrow.
    await mintTo(connection, client, mint, clientAta, client, 1_000_000_000);
  });

  // ── the happy path ─────────────────────────────────────────────────────────────────────────────

  it("locks the client's funds in a program-owned vault on create", async () => {
    const amount = new BN(1_000_000); // 1.000000
    const milestones = 4;
    const deadline = await nextDeadline();
    const escrow = escrowPda(client.publicKey, mint, deadline);
    const vault = vaultPda(escrow);

    const before = await getAccount(connection, clientAta);

    await program.methods
      .createEscrow(amount, milestones, new BN(deadline))
      .accounts(createAccounts(escrow, vault))
      .rpc();

    const after = await getAccount(connection, clientAta);
    assert.equal(
      BigInt(before.amount) - BigInt(after.amount),
      BigInt(amount.toString()),
      "the client's balance must drop by exactly the escrowed amount"
    );

    const vaultAcct = await getAccount(connection, vault);
    assert.equal(
      BigInt(vaultAcct.amount),
      BigInt(amount.toString()),
      "the money must be IN the vault, not merely promised"
    );
    // The claim that matters: the vault's authority is the escrow PDA, so neither party can move
    // it. If this ever reads as the client or the freelancer, the whole design has failed.
    assert.equal(vaultAcct.owner.toString(), program.programId.toString());
    assert.equal(
      vaultAcct.delegate,
      null,
      "no delegate may exist on the vault - that would be a backdoor"
    );

    const st = await program.account.escrow.fetch(escrow);
    assert.equal(st.client.toString(), client.publicKey.toString());
    assert.equal(st.mint.toString(), mint.toString());
    assert.equal(st.amount.toString(), amount.toString());
    assert.equal(st.milestones, milestones);
    assert.equal(st.approved, 0);
    assert.equal(st.deadline.toString(), deadline.toString());
    assert.isNull(st.freelancer, "nobody has accepted yet");
    assert.deepEqual(st.status, { open: {} });
  });

  it("pays exactly one milestone share per approval", async () => {
    const amount = new BN(1_000_000);
    const milestones = 4;
    const deadline = await nextDeadline();
    const escrow = escrowPda(client.publicKey, mint, deadline);
    const vault = vaultPda(escrow);

    await program.methods
      .createEscrow(amount, milestones, new BN(deadline))
      .accounts(createAccounts(escrow, vault))
      .rpc();

    await program.methods
      .acceptEscrow()
      .accounts({ freelancer: freelancer.publicKey, escrow })
      .signers([freelancer])
      .rpc();

    const beforePaid = await getAccount(connection, freelancerAta);

    await program.methods
      .approveMilestone()
      .accounts({
        client: client.publicKey,
        escrow,
        freelancer: freelancer.publicKey,
        mint,
        vault,
        freelancerTokenAccount: freelancerAta,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .rpc();

    const afterPaid = await getAccount(connection, freelancerAta);
    assert.equal(
      BigInt(afterPaid.amount) - BigInt(beforePaid.amount),
      BigInt(amount.toString()) / BigInt(milestones),
      "one approval must release exactly amount/milestones"
    );

    const st = await program.account.escrow.fetch(escrow);
    assert.equal(st.approved, 1);
    assert.deepEqual(st.status, { active: {} }, "a partially-paid job is still active");
  });

  it("marks the job completed when the final milestone is approved, and the vault empties", async () => {
    const amount = new BN(800_000);
    const milestones = 2;
    const deadline = await nextDeadline();
    const escrow = escrowPda(client.publicKey, mint, deadline);
    const vault = vaultPda(escrow);

    await program.methods
      .createEscrow(amount, milestones, new BN(deadline))
      .accounts(createAccounts(escrow, vault))
      .rpc();
    await program.methods
      .acceptEscrow()
      .accounts({ freelancer: freelancer.publicKey, escrow })
      .signers([freelancer])
      .rpc();

    for (let i = 0; i < milestones; i++) {
      await program.methods
        .approveMilestone()
        .accounts({
          client: client.publicKey,
          escrow,
          freelancer: freelancer.publicKey,
          mint,
          vault,
          freelancerTokenAccount: freelancerAta,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .rpc();
    }

    const st = await program.account.escrow.fetch(escrow);
    assert.deepEqual(st.status, { completed: {} });
    assert.equal(
      BigInt((await getAccount(connection, vault)).amount),
      0n,
      "a completed job must leave nothing in the vault - anything left is stranded forever"
    );
  });

  // ── the freelancer's protection: deadline + silence ────────────────────────────────────────────

  it("lets the freelancer claim the unreviewed balance once the client goes silent", async () => {
    const amount = new BN(1_000_000);
    const milestones = 4;
    const deadline = await nextDeadline(2); // short, so the test does not take a minute
    const escrow = escrowPda(client.publicKey, mint, deadline);
    const vault = vaultPda(escrow);

    await program.methods
      .createEscrow(amount, milestones, new BN(deadline))
      .accounts(createAccounts(escrow, vault))
      .rpc();
    await program.methods
      .acceptEscrow()
      .accounts({ freelancer: freelancer.publicKey, escrow })
      .signers([freelancer])
      .rpc();

    // Client reviews one milestone, then ceases answering.
    await program.methods
      .approveMilestone()
      .accounts({
        client: client.publicKey,
        escrow,
        freelancer: freelancer.publicKey,
        mint,
        vault,
        freelancerTokenAccount: freelancerAta,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .rpc();

    const before = await getAccount(connection, freelancerAta);
    await waitPast(deadline);

    await program.methods
      .claimUnreviewed()
      .accounts({
        freelancer: freelancer.publicKey,
        escrow,
        mint,
        vault,
        freelancerTokenAccount: freelancerAta,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .signers([freelancer])
      .rpc();

    const after = await getAccount(connection, freelancerAta);
    assert.equal(
      BigInt(after.amount) - BigInt(before.amount),
      BigInt(amount.toString()) - BigInt(amount.toString()) / BigInt(milestones),
      "the freelancer gets the REMAINING balance, not the whole amount again"
    );
    assert.equal(BigInt((await getAccount(connection, vault)).amount), 0n);
    assert.deepEqual((await program.account.escrow.fetch(escrow)).status, { completed: {} });
  });

  it("refuses a claim before the deadline the client chose", async () => {
    const deadline = await nextDeadline(3600);
    const escrow = escrowPda(client.publicKey, mint, deadline);
    const vault = vaultPda(escrow);

    await program.methods
      .createEscrow(new BN(400_000), 4, new BN(deadline))
      .accounts(createAccounts(escrow, vault))
      .rpc();
    await program.methods
      .acceptEscrow()
      .accounts({ freelancer: freelancer.publicKey, escrow })
      .signers([freelancer])
      .rpc();

    await expectFail(
      program.methods
        .claimUnreviewed()
        .accounts({
          freelancer: freelancer.publicKey,
          escrow,
          mint,
          vault,
          freelancerTokenAccount: freelancerAta,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .signers([freelancer])
        .rpc(),
      "deadline has not passed yet"
    );
  });

  it("refuses to let anyone but the freelancer claim", async () => {
    const deadline = await nextDeadline(2);
    const escrow = escrowPda(client.publicKey, mint, deadline);
    const vault = vaultPda(escrow);

    await program.methods
      .createEscrow(new BN(400_000), 4, new BN(deadline))
      .accounts(createAccounts(escrow, vault))
      .rpc();
    await program.methods
      .acceptEscrow()
      .accounts({ freelancer: freelancer.publicKey, escrow })
      .signers([freelancer])
      .rpc();

    const strangerAta = await createAccount(connection, client, mint, stranger.publicKey);
    await waitPast(deadline);

    await expectFail(
      program.methods
        .claimUnreviewed()
        .accounts({
          freelancer: stranger.publicKey,
          escrow,
          mint,
          vault,
          freelancerTokenAccount: strangerAta,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .signers([stranger])
        .rpc(),
      "only the escrow's freelancer may do this"
    );
  });

  // ── the client's protection: refund, but only before anyone accepts ───────────────────────────

  it("refunds the client in full while the job is still open", async () => {
    const amount = new BN(600_000);
    const deadline = await nextDeadline();
    const escrow = escrowPda(client.publicKey, mint, deadline);
    const vault = vaultPda(escrow);

    await program.methods
      .createEscrow(amount, 3, new BN(deadline))
      .accounts(createAccounts(escrow, vault))
      .rpc();

    const before = await getAccount(connection, clientAta);
    await program.methods
      .cancelEscrow()
      .accounts({
        client: client.publicKey,
        escrow,
        mint,
        vault,
        clientTokenAccount: clientAta,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .rpc();
    const after = await getAccount(connection, clientAta);

    assert.equal(
      BigInt(after.amount) - BigInt(before.amount),
      BigInt(amount.toString()),
      "an unaccepted job must refund every token"
    );
    assert.deepEqual((await program.account.escrow.fetch(escrow)).status, { cancelled: {} });
  });

  it("refuses to let the client cancel AFTER a freelancer accepted", async () => {
    // This is the instruction that would turn the program into the platform it replaces: a client
    // who can cancel after work starts holds exactly the unilateral power being removed.
    const deadline = await nextDeadline();
    const escrow = escrowPda(client.publicKey, mint, deadline);
    const vault = vaultPda(escrow);

    await program.methods
      .createEscrow(new BN(600_000), 3, new BN(deadline))
      .accounts(createAccounts(escrow, vault))
      .rpc();
    await program.methods
      .acceptEscrow()
      .accounts({ freelancer: freelancer.publicKey, escrow })
      .signers([freelancer])
      .rpc();

    await expectFail(
      program.methods
        .cancelEscrow()
        .accounts({
          client: client.publicKey,
          escrow,
          mint,
          vault,
          clientTokenAccount: clientAta,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .rpc(),
      "a freelancer has already accepted this escrow"
    );
  });

  // ── input validation ──────────────────────────────────────────────────────────────────────────

  it("rejects an amount that does not divide evenly by the milestone count", async () => {
    // An uneven split would leave a remainder in the vault with no instruction able to pay it out.
    const deadline = await nextDeadline();
    const escrow = escrowPda(client.publicKey, mint, deadline);
    const vault = vaultPda(escrow);

    await expectFail(
      program.methods
        .createEscrow(new BN(1_000_001), 4, new BN(deadline))
        .accounts(createAccounts(escrow, vault))
        .rpc(),
      "amount must divide evenly"
    );
  });

  it("rejects a deadline in the past", async () => {
    const deadline = (await chainNow()) - 60;
    const escrow = escrowPda(client.publicKey, mint, deadline);
    const vault = vaultPda(escrow);

    await expectFail(
      program.methods
        .createEscrow(new BN(400_000), 4, new BN(deadline))
        .accounts(createAccounts(escrow, vault))
        .rpc(),
      "deadline must be in the future"
    );
  });

  it("rejects a zero amount and a zero milestone count", async () => {
    const deadline = await nextDeadline();
    const escrow = escrowPda(client.publicKey, mint, deadline);
    const vault = vaultPda(escrow);

    await expectFail(
      program.methods
        .createEscrow(new BN(0), 4, new BN(deadline))
        .accounts(createAccounts(escrow, vault))
        .rpc(),
      "amount must be greater than zero"
    );

    const deadline2 = await nextDeadline();
    const escrow2 = escrowPda(client.publicKey, mint, deadline2);
    await expectFail(
      program.methods
        .createEscrow(new BN(400_000), 0, new BN(deadline2))
        .accounts(createAccounts(escrow2, vaultPda(escrow2)))
        .rpc(),
      "a job needs at least one milestone"
    );
  });

  it("rejects a client accepting their own job", async () => {
    const deadline = await nextDeadline();
    const escrow = escrowPda(client.publicKey, mint, deadline);
    const vault = vaultPda(escrow);

    await program.methods
      .createEscrow(new BN(400_000), 4, new BN(deadline))
      .accounts(createAccounts(escrow, vault))
      .rpc();

    await expectFail(
      program.methods
        .acceptEscrow()
        .accounts({ freelancer: client.publicKey, escrow })
        .rpc(),
      "client cannot also be the freelancer"
    );
  });

  it("rejects accepting a job that is already taken", async () => {
    const deadline = await nextDeadline();
    const escrow = escrowPda(client.publicKey, mint, deadline);
    const vault = vaultPda(escrow);

    await program.methods
      .createEscrow(new BN(400_000), 4, new BN(deadline))
      .accounts(createAccounts(escrow, vault))
      .rpc();
    await program.methods
      .acceptEscrow()
      .accounts({ freelancer: freelancer.publicKey, escrow })
      .signers([freelancer])
      .rpc();

    // A second freelancer must not be able to take a job someone is already working.
    await expectFail(
      program.methods
        .acceptEscrow()
        .accounts({ freelancer: stranger.publicKey, escrow })
        .signers([stranger])
        .rpc(),
      "escrow is not open"
    );
  });

  it("rejects approving a milestone on a job nobody has accepted", async () => {
    // Approving before acceptance would pay a freelancer who never committed, and would leave
    // `approved` ahead of any acceptance. The Active gate is what forbids it.
    const deadline = await nextDeadline();
    const escrow = escrowPda(client.publicKey, mint, deadline);
    const vault = vaultPda(escrow);

    await program.methods
      .createEscrow(new BN(400_000), 4, new BN(deadline))
      .accounts(createAccounts(escrow, vault))
      .rpc();

    await expectFail(
      program.methods
        .approveMilestone()
        .accounts({
          client: client.publicKey,
          escrow,
          freelancer: freelancer.publicKey,
          mint,
          vault,
          freelancerTokenAccount: freelancerAta,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .rpc(),
      "escrow is not active"
    );
  });

  it("refuses to close if a stray donation is sitting in the vault", async () => {
    // Anybody can send tokens to a token account, so a finished escrow can still have a balance
    // that was never part of the deal. Closing would either burn it or strand the rent, so the
    // program refuses and says so. This is a KNOWN LIMITATION, recorded rather than hidden: the
    // vault's only authority is the escrow PDA and no instruction spends a terminal escrow, so
    // that residue is not recoverable by this program. It costs ~0.002 SOL of rent, it cannot
    // steal anything, and the alternative (adding a client token account to the close path) would
    // make closing fail for anyone who has already closed their own ATA — a worse brick.
    const amount = new BN(400_000);
    const deadline = await nextDeadline();
    const escrow = escrowPda(client.publicKey, mint, deadline);
    const vault = vaultPda(escrow);

    await program.methods
      .createEscrow(amount, 4, new BN(deadline))
      .accounts(createAccounts(escrow, vault))
      .rpc();
    await program.methods
      .cancelEscrow()
      .accounts({
        client: client.publicKey,
        escrow,
        mint,
        vault,
        clientTokenAccount: clientAta,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .rpc();

    // one base unit, donated by a passer-by
    await transfer(connection, client, clientAta, vault, client, 1);

    await expectFail(
      program.methods
        .closeEscrow()
        .accounts({ client: client.publicKey, escrow, vault, tokenProgram: TOKEN_PROGRAM_ID })
        .rpc(),
      "vault still holds tokens"
    );

    // and the donor's unit is still sitting there, untouched - refused, not burned.
    assert.equal(BigInt((await getAccount(connection, vault)).amount), 1n);
  });

  it("cannot reach the state that NothingToClaim guards - the invariant, not the error", async () => {
    // `claim_unreviewed` guards against `remaining == 0` with NothingToClaim. Given the
    // create-time divisibility check and the Completed transition on the final approval, that
    // state is UNREACHABLE - which means the guard can never fire and the error is dead code.
    //
    // Rather than fake a test for an unreachable branch, this asserts the INVARIANT that makes it
    // unreachable: paying every milestone leaves the job Completed with an empty vault, so there
    // is no "Active but fully paid" state for the guard to catch. If someone later relaxes the
    // transition, this test fails and the guard becomes live again.
    const amount = new BN(400_000);
    const milestones = 4;
    const deadline = await nextDeadline();
    const escrow = escrowPda(client.publicKey, mint, deadline);
    const vault = vaultPda(escrow);

    await program.methods
      .createEscrow(amount, milestones, new BN(deadline))
      .accounts(createAccounts(escrow, vault))
      .rpc();
    await program.methods
      .acceptEscrow()
      .accounts({ freelancer: freelancer.publicKey, escrow })
      .signers([freelancer])
      .rpc();

    for (let i = 0; i < milestones - 1; i++) {
      await program.methods
        .approveMilestone()
        .accounts({
          client: client.publicKey,
          escrow,
          freelancer: freelancer.publicKey,
          mint,
          vault,
          freelancerTokenAccount: freelancerAta,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .rpc();
    }
    const mid = await program.account.escrow.fetch(escrow);
    assert.deepEqual(mid.status, { active: {} }, "one approval short of the end is still Active");
    assert.isAbove(
      Number(BigInt((await getAccount(connection, vault)).amount)),
      0,
      "and it still holds a claimable balance - so remaining > 0 whenever status is Active"
    );

    await program.methods
      .approveMilestone()
      .accounts({
        client: client.publicKey,
        escrow,
        freelancer: freelancer.publicKey,
        mint,
        vault,
        freelancerTokenAccount: freelancerAta,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .rpc();

    const done = await program.account.escrow.fetch(escrow);
    assert.deepEqual(done.status, { completed: {} }, "the last approval flips the status");
    assert.equal(
      BigInt((await getAccount(connection, vault)).amount),
      0n,
      "so Active always implies remaining > 0: NothingToClaim is unreachable by construction"
    );
  });

  // ── cleanup ───────────────────────────────────────────────────────────────────────────────────

  it("returns the rent to the client once a job is finished", async () => {
    const amount = new BN(400_000);
    const deadline = await nextDeadline();
    const escrow = escrowPda(client.publicKey, mint, deadline);
    const vault = vaultPda(escrow);

    await program.methods
      .createEscrow(amount, 4, new BN(deadline))
      .accounts(createAccounts(escrow, vault))
      .rpc();
    await program.methods
      .acceptEscrow()
      .accounts({ freelancer: freelancer.publicKey, escrow })
      .signers([freelancer])
      .rpc();

    // Finish it.
    for (let i = 0; i < 4; i++) {
      await program.methods
        .approveMilestone()
        .accounts({
          client: client.publicKey,
          escrow,
          freelancer: freelancer.publicKey,
          mint,
          vault,
          freelancerTokenAccount: freelancerAta,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .rpc();
    }

    const rent = await connection.getBalance(escrow);
    assert.isAbove(rent, 0, "the escrow account holds rent before closing");

    const before = await connection.getBalance(client.publicKey);
    await program.methods
      .closeEscrow()
      .accounts({
        client: client.publicKey,
        escrow,
        vault,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .rpc();
    const after = await connection.getBalance(client.publicKey);

    assert.isNull(
      await connection.getAccountInfo(escrow),
      "the escrow account must be gone after closing"
    );
    assert.isNull(
      await connection.getAccountInfo(vault),
      "the vault must be gone too - an orphaned token account is rent nobody can reclaim"
    );
    assert.isAbove(
      after,
      before,
      "the client must get the rent back; fees are far smaller than the reclaimed rent"
    );
  });

  it("refuses to close a job that is still live", async () => {
    const deadline = await nextDeadline();
    const escrow = escrowPda(client.publicKey, mint, deadline);
    const vault = vaultPda(escrow);

    await program.methods
      .createEscrow(new BN(400_000), 4, new BN(deadline))
      .accounts(createAccounts(escrow, vault))
      .rpc();

    await expectFail(
      program.methods
        .closeEscrow()
        .accounts({ client: client.publicKey, escrow, vault, tokenProgram: TOKEN_PROGRAM_ID })
        .rpc(),
      "must be completed or cancelled before it can be closed"
    );
  });
});
