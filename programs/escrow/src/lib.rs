//! Trustless Milestone Escrow — removing the platform from freelance payments.
//!
//! THE INTERMEDIARY THIS REMOVES
//! -----------------------------
//! Today a client pays a freelance platform (Upwork, Fiverr, a bank escrow, a broker). The platform
//! holds the money, decides when it moves, decides who is right in a dispute, and can freeze or
//! reverse a payment unilaterally. That is a real cost — a fee on every job — and a real risk, in
//! both directions: clients can withhold payment for delivered work, and freelancers can take money
//! without delivering.
//!
//! This program moves those terms on-chain, so the rule that decides is code that neither party can
//! change once funds are locked, and no third party is ever in custody of the money.
//!
//! WHAT REPLACES THE ARBITRATOR'S JUDGEMENT
//! ---------------------------------------
//! A platform resolves "did they deliver?" by opinion. That cannot be put on-chain honestly, so this
//! program does not pretend to. Instead it removes the NEED for that judgement with two rules:
//!
//!   1. MILESTONES. Work is split into n milestones, each worth `amount / n`. The client controls
//!      release per milestone, so a client is never asked to trust an entire job up front, and a
//!      freelancer is paid as they deliver rather than at the end. This is the part that makes the
//!      client comfortable locking funds at all.
//!
//!   2. A DEADLINE. If the client goes silent — the single most common failure mode of a
//!      client-hosted escrow — the freelancer can claim the REMAINING balance once the deadline
//!      passes. The client cannot ghost and keep money for delivered work forever.
//!
//! The client's protection is that they choose the deadline and pay per milestone. The freelancer's
//! protection is that no human is holding the money and silence has a terminus. Neither needs to be
//! trusted with custody, because the vault is a program-derived account that only these
//! instructions can move.
//!
//! Deliberately NOT included: an owner-only admin instruction. A backdoor that can move user funds
//! would reintroduce exactly the intermediary this program exists to remove.

use anchor_lang::prelude::*;
use anchor_spl::token::{self, CloseAccount, Mint, Token, TokenAccount, Transfer};

declare_id!("GPmJtpLs7u7BCfUHjRyaffjPSKuJjEjLY1qztzgtVgpC");

#[program]
pub mod escrow {
    use super::*;

    /// Client opens a job and locks the full amount in a PDA-owned vault in one step.
    ///
    /// Funding at creation (rather than later) is the whole point: the freelancer can verify the
    /// money exists on-chain before doing any work, instead of trusting a screenshot.
    pub fn create_escrow(ctx: Context<CreateEscrow>, amount: u64, milestones: u8, deadline: i64) -> Result<()> {
        require!(amount > 0, EscrowError::ZeroAmount);
        require!(milestones > 0, EscrowError::NoMilestones);

        // Dividing the amount must be exact. If it is not, the remainder would have nowhere to go
        // and would silently strand in the vault — so refuse the job instead of building in a leak.
        require!(amount % (milestones as u64) == 0, EscrowError::UnevenMilestones);

        // A deadline in the past would let the freelancer claim instantly the moment they accept.
        let now = Clock::get()?.unix_timestamp;
        require!(deadline > now, EscrowError::DeadlineInPast);

        let escrow = &mut ctx.accounts.escrow;
        escrow.client = ctx.accounts.client.key();
        escrow.freelancer = None;
        escrow.mint = ctx.accounts.mint.key();
        escrow.amount = amount;
        escrow.milestones = milestones;
        escrow.approved = 0;
        escrow.deadline = deadline;
        escrow.status = EscrowStatus::Open;
        escrow.bump = ctx.bumps.escrow;
        escrow.vault_bump = ctx.bumps.vault;

        // Move the client's funds into the vault. From here the client cannot withdraw them at will:
        // only `approve_milestone` (to the freelancer) or `cancel_escrow` (refund, and only while the
        // job is still Open) can move them out.
        token::transfer(
            CpiContext::new(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.client_token_account.to_account_info(),
                    to: ctx.accounts.vault.to_account_info(),
                    authority: ctx.accounts.client.to_account_info(),
                },
            ),
            amount,
        )?;

        emit!(EscrowCreated {
            escrow: escrow.key(),
            client: escrow.client,
            amount,
            milestones,
            deadline,
        });
        Ok(())
    }

    /// A freelancer takes the job. Until this happens the client may still cancel for a full refund;
    /// after it, the deadline clock is the freelancer's protection and cancellation is closed.
    pub fn accept_escrow(ctx: Context<AcceptEscrow>) -> Result<()> {
        let escrow = &mut ctx.accounts.escrow;
        require!(escrow.status == EscrowStatus::Open, EscrowError::NotOpen);

        // Refuse self-dealing, which would let one wallet masquerade as both sides of a job.
        require_keys_neq!(ctx.accounts.freelancer.key(), escrow.client, EscrowError::SelfDealing);

        escrow.freelancer = Some(ctx.accounts.freelancer.key());
        escrow.status = EscrowStatus::Active;

        emit!(EscrowAccepted { escrow: escrow.key(), freelancer: ctx.accounts.freelancer.key() });
        Ok(())
    }

    /// Client approves one milestone, releasing its share to the freelancer immediately.
    ///
    /// Releasing per milestone is what keeps this honest without an arbitrator: the client never
    /// hands over the whole job's value before seeing anything, and the freelancer is never asked to
    /// deliver everything on a promise.
    ///
    /// The transfer below signs with `escrow.to_account_info()`, not
    /// `ctx.accounts.escrow.to_account_info()`. `escrow` holds this account behind a mutable borrow
    /// for the whole instruction, so naming the field again would be a second, conflicting borrow of
    /// the same account and rustc rejects it (E0502). Going through the existing reference is the
    /// same call on the same `AccountInfo`. `cancel_escrow` and `claim_unreviewed` sign identically.
    pub fn approve_milestone(ctx: Context<ApproveMilestone>) -> Result<()> {
        let escrow = &mut ctx.accounts.escrow;
        require!(escrow.status == EscrowStatus::Active, EscrowError::NotActive);

        let freelancer = escrow.freelancer.ok_or(EscrowError::NotActive)?;
        require_keys_eq!(ctx.accounts.freelancer.key(), freelancer, EscrowError::WrongFreelancer);

        let share = escrow.amount / (escrow.milestones as u64);
        escrow.approved += 1;
        if escrow.approved == escrow.milestones {
            escrow.status = EscrowStatus::Completed;
        }

        let escrow_key = escrow.key();
        let seeds: &[&[u8]] = &[b"escrow", escrow.client.as_ref(), &[escrow.bump]];
        token::transfer(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.vault.to_account_info(),
                    to: ctx.accounts.freelancer_token_account.to_account_info(),
                    authority: escrow.to_account_info(),
                },
                &[seeds],
            ),
            share,
        )?;

        emit!(MilestoneApproved { escrow: escrow_key, paid: share, approved: escrow.approved });
        Ok(())
    }

    /// Client refunds themselves — allowed ONLY while no freelancer has accepted.
    ///
    /// Gating on `Open` is deliberate. A client who could cancel after the freelancer started would
    /// hold the same unilateral power as the platform this program removes.
    pub fn cancel_escrow(ctx: Context<CancelEscrow>) -> Result<()> {
        let escrow = &mut ctx.accounts.escrow;
        require!(escrow.status == EscrowStatus::Open, EscrowError::AlreadyAccepted);

        let escrow_key = escrow.key();
        let remaining = escrow.amount - (escrow.approved as u64) * (escrow.amount / escrow.milestones as u64);
        let seeds: &[&[u8]] = &[b"escrow", escrow.client.as_ref(), &[escrow.bump]];
        token::transfer(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.vault.to_account_info(),
                    to: ctx.accounts.client_token_account.to_account_info(),
                    authority: escrow.to_account_info(),
                },
                &[seeds],
            ),
            remaining,
        )?;

        escrow.status = EscrowStatus::Cancelled;
        emit!(EscrowCancelled { escrow: escrow_key, refunded: remaining });
        Ok(())
    }

    /// Freelancer claims the UNREVIEWED balance once the deadline has passed.
    ///
    /// This is the instruction that replaces the dispute system. There is no argument to win and no
    /// support ticket to file: after a deadline the client chose, silence is not a way to keep money
    /// that was locked against delivered work. Anything the client already approved was paid at the
    /// time, so this only ever releases what is genuinely still unjudged.
    pub fn claim_unreviewed(ctx: Context<ClaimUnreviewed>) -> Result<()> {
        let escrow = &mut ctx.accounts.escrow;
        require!(escrow.status == EscrowStatus::Active, EscrowError::NotActive);

        let freelancer = escrow.freelancer.ok_or(EscrowError::NotActive)?;
        require_keys_eq!(ctx.accounts.freelancer.key(), freelancer, EscrowError::WrongFreelancer);

        let now = Clock::get()?.unix_timestamp;
        require!(now > escrow.deadline, EscrowError::DeadlineNotReached);

        let remaining = escrow.amount - (escrow.approved as u64) * (escrow.amount / escrow.milestones as u64);
        require!(remaining > 0, EscrowError::NothingToClaim);

        let escrow_key = escrow.key();
        let seeds: &[&[u8]] = &[b"escrow", escrow.client.as_ref(), &[escrow.bump]];
        token::transfer(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.vault.to_account_info(),
                    to: ctx.accounts.freelancer_token_account.to_account_info(),
                    authority: escrow.to_account_info(),
                },
                &[seeds],
            ),
            remaining,
        )?;

        escrow.status = EscrowStatus::Completed;
        emit!(UnreviewedClaimed { escrow: escrow_key, claimed: remaining });
        Ok(())
    }

    /// Return the rent on a finished job to the client who paid it.
    ///
    /// Neither settlement path deletes the accounts it settles, which would leave the escrow
    /// account and the vault holding rent forever. This is a separate instruction on purpose:
    /// settlement must never fail for a reason unrelated to settlement, so cleanup cannot be
    /// bundled into it. A job that cannot be swept is an annoyance; a job that cannot be settled
    /// is the bug this program exists to remove.
    pub fn close_escrow(ctx: Context<CloseEscrow>) -> Result<()> {
        let escrow = &ctx.accounts.escrow;

        require!(
            escrow.status == EscrowStatus::Completed || escrow.status == EscrowStatus::Cancelled,
            EscrowError::StillLive
        );

        // The token program refuses to close an account that still holds a balance. Checking here
        // turns a confusing CPI failure into a named error, and refuses rather than silently
        // discarding a vault balance — stranding a bug is better than burning it.
        require!(ctx.accounts.vault.amount == 0, EscrowError::VaultNotEmpty);

        let escrow_key = escrow.key();
        let seeds: &[&[u8]] = &[b"escrow", escrow.client.as_ref(), &[escrow.bump]];
        token::close_account(CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            CloseAccount {
                account: ctx.accounts.vault.to_account_info(),
                destination: ctx.accounts.client.to_account_info(),
                authority: ctx.accounts.escrow.to_account_info(),
            },
            &[seeds],
        ))?;

        emit!(EscrowClosed { escrow: escrow_key });
        Ok(())
    }
}

// ── state ────────────────────────────────────────────────────────────────────────────────────────

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, InitSpace)]
pub enum EscrowStatus {
    Open,       // funded, waiting for a freelancer
    Active,     // freelancer accepted; milestone releases and the deadline apply
    Completed,  // fully paid out, or claimed after the deadline
    Cancelled,  // refunded before anyone accepted
}

#[account]
#[derive(InitSpace)]
pub struct Escrow {
    pub client: Pubkey,
    /// None until a freelancer accepts — which is exactly why `cancel_escrow` can gate on it.
    pub freelancer: Option<Pubkey>,
    pub mint: Pubkey,
    pub amount: u64,
    pub milestones: u8,
    pub approved: u8,
    /// Unix seconds. After this the freelancer may claim what the client has not reviewed.
    pub deadline: i64,
    pub status: EscrowStatus,
    pub bump: u8,
    pub vault_bump: u8,
}

// ── contexts ─────────────────────────────────────────────────────────────────────────────────────

#[derive(Accounts)]
#[instruction(amount: u64, milestones: u8, deadline: i64)]
pub struct CreateEscrow<'info> {
    #[account(mut)]
    pub client: Signer<'info>,
    #[account(
        init,
        payer = client,
        space = 8 + Escrow::INIT_SPACE,
        // One escrow per client per mint per deadline: a wrong-but-valid PDA here would send funds
        // to an account nobody is watching, so the seeds are explicit and deterministic.
        seeds = [b"escrow", client.key().as_ref(), mint.key().as_ref(), &deadline.to_le_bytes()],
        bump
    )]
    pub escrow: Account<'info, Escrow>,
    /// NOTE: deliberately NOT constrained to `escrow.mint` here. On `init` the escrow account is
    /// still zeroed, so that constraint would compare against the default pubkey and reject every
    /// valid job. The handler sets `escrow.mint` from this account, which is the binding for this
    /// instruction; every later instruction binds the other way, from `escrow.mint`.
    pub mint: Account<'info, Mint>,
    #[account(mut, token::mint = mint, token::authority = client)]
    pub client_token_account: Account<'info, TokenAccount>,
    /// The vault is owned by the escrow PDA, so only this program can move its funds — not the
    /// client, not the freelancer, and not anyone with the private key to either.
    #[account(
        init,
        payer = client,
        token::mint = mint,
        token::authority = escrow,
        seeds = [b"vault", escrow.key().as_ref()],
        bump
    )]
    pub vault: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
    pub rent: Sysvar<'info, Rent>,
}

#[derive(Accounts)]
pub struct AcceptEscrow<'info> {
    #[account(mut)]
    pub freelancer: Signer<'info>,
    #[account(mut, seeds = [b"escrow", escrow.client.as_ref(), escrow.mint.as_ref(), &escrow.deadline.to_le_bytes()], bump = escrow.bump)]
    pub escrow: Account<'info, Escrow>,
}

#[derive(Accounts)]
pub struct ApproveMilestone<'info> {
    #[account(mut)]
    pub client: Signer<'info>,
    #[account(mut, has_one = client, seeds = [b"escrow", escrow.client.as_ref(), escrow.mint.as_ref(), &escrow.deadline.to_le_bytes()], bump = escrow.bump)]
    pub escrow: Account<'info, Escrow>,
    /// CHECK: compared against `escrow.freelancer` in the handler; the PDA signs the transfer, so
    /// this account is never an authority and needs no ownership check here.
    pub freelancer: UncheckedAccount<'info>,
    /// Bound to the escrow's own mint. Without this a caller could supply an unrelated mint and
    /// the only thing stopping them would be the token program's own mint check — correct, but by
    /// accident rather than by design.
    ///
    /// `address`, not `token::mint`: a `Mint` account has no `mint` field of its own, so
    /// `token::mint = ..` is a compile error here. That is only obvious once rustc says so.
    #[account(address = escrow.mint)]
    pub mint: Account<'info, Mint>,
    #[account(mut, seeds = [b"vault", escrow.key().as_ref()], bump = escrow.vault_bump)]
    pub vault: Account<'info, TokenAccount>,
    #[account(mut, token::mint = mint)]
    pub freelancer_token_account: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct CancelEscrow<'info> {
    #[account(mut)]
    pub client: Signer<'info>,
    #[account(mut, has_one = client, seeds = [b"escrow", escrow.client.as_ref(), escrow.mint.as_ref(), &escrow.deadline.to_le_bytes()], bump = escrow.bump)]
    pub escrow: Account<'info, Escrow>,
    /// Bound to the escrow's own mint. Without this a caller could supply an unrelated mint and
    /// the only thing stopping them would be the token program's own mint check — correct, but by
    /// accident rather than by design.
    ///
    /// `address`, not `token::mint`: a `Mint` account has no `mint` field of its own, so
    /// `token::mint = ..` is a compile error here. That is only obvious once rustc says so.
    #[account(address = escrow.mint)]
    pub mint: Account<'info, Mint>,
    #[account(mut, seeds = [b"vault", escrow.key().as_ref()], bump = escrow.vault_bump)]
    pub vault: Account<'info, TokenAccount>,
    #[account(mut, token::mint = mint, token::authority = client)]
    pub client_token_account: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct ClaimUnreviewed<'info> {
    #[account(mut)]
    pub freelancer: Signer<'info>,
    #[account(mut, seeds = [b"escrow", escrow.client.as_ref(), escrow.mint.as_ref(), &escrow.deadline.to_le_bytes()], bump = escrow.bump)]
    pub escrow: Account<'info, Escrow>,
    /// Bound to the escrow's own mint. Without this a caller could supply an unrelated mint and
    /// the only thing stopping them would be the token program's own mint check — correct, but by
    /// accident rather than by design.
    ///
    /// `address`, not `token::mint`: a `Mint` account has no `mint` field of its own, so
    /// `token::mint = ..` is a compile error here. That is only obvious once rustc says so.
    #[account(address = escrow.mint)]
    pub mint: Account<'info, Mint>,
    #[account(mut, seeds = [b"vault", escrow.key().as_ref()], bump = escrow.vault_bump)]
    pub vault: Account<'info, TokenAccount>,
    #[account(mut, token::mint = mint)]
    pub freelancer_token_account: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct CloseEscrow<'info> {
    /// Also the destination for the reclaimed rent, because the client is the account that paid
    /// it. `has_one = client` on the escrow is what makes that safe — the signer must be the same
    /// key the escrow was created by.
    #[account(mut)]
    pub client: Signer<'info>,
    #[account(
        mut,
        has_one = client,
        close = client,
        seeds = [b"escrow", escrow.client.as_ref(), escrow.mint.as_ref(), &escrow.deadline.to_le_bytes()],
        bump = escrow.bump
    )]
    pub escrow: Account<'info, Escrow>,
    #[account(mut, seeds = [b"vault", escrow.key().as_ref()], bump = escrow.vault_bump)]
    pub vault: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
}

// ── errors + events ──────────────────────────────────────────────────────────────────────────────

#[error_code]
pub enum EscrowError {
    #[msg("amount must be greater than zero")]
    ZeroAmount,
    #[msg("a job needs at least one milestone")]
    NoMilestones,
    #[msg("amount must divide evenly by the milestone count, or the remainder would strand in the vault")]
    UnevenMilestones,
    #[msg("deadline must be in the future")]
    DeadlineInPast,
    #[msg("escrow is not open")]
    NotOpen,
    #[msg("escrow is not active")]
    NotActive,
    #[msg("client cannot also be the freelancer")]
    SelfDealing,
    #[msg("only the escrow's freelancer may do this")]
    WrongFreelancer,
    #[msg("a freelancer has already accepted this escrow")]
    AlreadyAccepted,
    #[msg("deadline has not passed yet")]
    DeadlineNotReached,
    #[msg("nothing left to claim")]
    NothingToClaim,
    #[msg("escrow must be completed or cancelled before it can be closed")]
    StillLive,
    #[msg("vault still holds tokens - refusing to close and strand them")]
    VaultNotEmpty,
}

#[event]
pub struct EscrowCreated {
    pub escrow: Pubkey,
    pub client: Pubkey,
    pub amount: u64,
    pub milestones: u8,
    pub deadline: i64,
}

#[event]
pub struct EscrowAccepted { pub escrow: Pubkey, pub freelancer: Pubkey }

#[event]
pub struct MilestoneApproved { pub escrow: Pubkey, pub paid: u64, pub approved: u8 }

#[event]
pub struct EscrowCancelled { pub escrow: Pubkey, pub refunded: u64 }

#[event]
pub struct UnreviewedClaimed { pub escrow: Pubkey, pub claimed: u64 }

#[event]
pub struct EscrowClosed { pub escrow: Pubkey }
