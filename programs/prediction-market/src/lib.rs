//! Prediction Market — binary-outcome AMM with oracle resolution.
//!
//! Design notes
//! ------------
//! Each market has two outcome token reserves (YES, NO) held in program-owned
//! token accounts. A constant-product invariant `x * y = k` is used for pricing,
//! analogous to Uniswap v2 but over outcome shares rather than two independent
//! assets. One unit of collateral can always be split into 1 YES + 1 NO share
//! (and merged back), which bounds prices to [0, 1] and makes the AMM
//! equivalent to the FPMM used by several production prediction markets.
//!
//! Lifecycle
//!   1. `initialize_market`  — admin creates market, seeds initial liquidity.
//!   2. `buy` / `sell`       — traders swap collateral <-> outcome shares.
//!   3. `resolve_market`     — oracle posts winning outcome after `close_ts`.
//!   4. `claim`              — holders of winning shares redeem 1:1 collateral.
//!
//! The program emits structured events that the off-chain indexer consumes.

use anchor_lang::prelude::*;
use anchor_spl::token::{self, Mint, Token, TokenAccount, Transfer};

declare_id!("PMrkt1111111111111111111111111111111111111");

pub const FEE_BPS_MAX: u16 = 500; // 5% hard cap
pub const BPS_DENOM: u64 = 10_000;

#[program]
pub mod prediction_market {
    use super::*;

    /// Create a new market. The creator seeds initial outcome reserves to
    /// define the starting implied probability (ratio of NO reserve to total).
    pub fn initialize_market(
        ctx: Context<InitializeMarket>,
        params: InitializeMarketParams,
    ) -> Result<()> {
        require!(params.fee_bps <= FEE_BPS_MAX, MarketError::FeeTooHigh);
        require!(params.close_ts > Clock::get()?.unix_timestamp, MarketError::CloseInPast);
        require!(
            params.initial_yes_reserve > 0 && params.initial_no_reserve > 0,
            MarketError::ZeroLiquidity
        );

        let market = &mut ctx.accounts.market;
        market.bump = ctx.bumps.market;
        market.creator = ctx.accounts.creator.key();
        market.oracle = params.oracle;
        market.collateral_mint = ctx.accounts.collateral_mint.key();
        market.yes_vault = ctx.accounts.yes_vault.key();
        market.no_vault = ctx.accounts.no_vault.key();
        market.collateral_vault = ctx.accounts.collateral_vault.key();
        market.yes_reserve = params.initial_yes_reserve;
        market.no_reserve = params.initial_no_reserve;
        market.total_volume = 0;
        market.fee_bps = params.fee_bps;
        market.close_ts = params.close_ts;
        market.resolution_ts = 0;
        market.state = MarketState::Open as u8;
        market.winning_outcome = Outcome::Unresolved as u8;
        market.question = params.question;

        // Transfer initial collateral from creator to cover the split that
        // produced the seeded outcome shares (max(yes, no) * 1 collateral unit).
        let seed_collateral = params.initial_yes_reserve.max(params.initial_no_reserve);
        token::transfer(
            CpiContext::new(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.creator_collateral.to_account_info(),
                    to: ctx.accounts.collateral_vault.to_account_info(),
                    authority: ctx.accounts.creator.to_account_info(),
                },
            ),
            seed_collateral,
        )?;

        emit!(MarketInitialized {
            market: market.key(),
            creator: market.creator,
            oracle: market.oracle,
            collateral_mint: market.collateral_mint,
            yes_reserve: market.yes_reserve,
            no_reserve: market.no_reserve,
            close_ts: market.close_ts,
            fee_bps: market.fee_bps,
            question: market.question.clone(),
        });
        Ok(())
    }

    /// Buy `outcome` shares, paying collateral. Uses constant-product pricing
    /// against the opposite reserve (Uniswap v2 semantics).
    pub fn buy(ctx: Context<Trade>, outcome: u8, amount_in: u64, min_shares_out: u64) -> Result<()> {
        let market = &mut ctx.accounts.market;
        require!(market.state == MarketState::Open as u8, MarketError::MarketClosed);
        require!(Clock::get()?.unix_timestamp < market.close_ts, MarketError::TradingHalted);
        require!(amount_in > 0, MarketError::ZeroAmount);

        let fee = mul_div(amount_in, market.fee_bps as u64, BPS_DENOM)?;
        let net_in = amount_in.checked_sub(fee).ok_or(MarketError::MathOverflow)?;

        let (in_reserve, out_reserve) = match Outcome::from_u8(outcome)? {
            Outcome::Yes => (market.no_reserve, market.yes_reserve),
            Outcome::No => (market.yes_reserve, market.no_reserve),
            _ => return err!(MarketError::InvalidOutcome),
        };

        // shares_out = out_reserve - k / (in_reserve + net_in)
        let k = (in_reserve as u128).checked_mul(out_reserve as u128).ok_or(MarketError::MathOverflow)?;
        let new_in = (in_reserve as u128).checked_add(net_in as u128).ok_or(MarketError::MathOverflow)?;
        let new_out = k.checked_div(new_in).ok_or(MarketError::MathOverflow)?;
        let shares_out_u128 = (out_reserve as u128).checked_sub(new_out).ok_or(MarketError::MathOverflow)?;
        let shares_out: u64 = shares_out_u128.try_into().map_err(|_| MarketError::MathOverflow)?;
        require!(shares_out >= min_shares_out, MarketError::SlippageExceeded);

        // Pull collateral in.
        token::transfer(
            CpiContext::new(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.trader_collateral.to_account_info(),
                    to: ctx.accounts.collateral_vault.to_account_info(),
                    authority: ctx.accounts.trader.to_account_info(),
                },
            ),
            amount_in,
        )?;

        // Update reserves: buying YES decreases YES reserve, increases NO reserve.
        match Outcome::from_u8(outcome)? {
            Outcome::Yes => {
                market.no_reserve = new_in as u64;
                market.yes_reserve = new_out as u64;
            }
            Outcome::No => {
                market.yes_reserve = new_in as u64;
                market.no_reserve = new_out as u64;
            }
            _ => return err!(MarketError::InvalidOutcome),
        }
        market.total_volume = market.total_volume.saturating_add(amount_in);

        // Mint outcome shares to trader by transferring from program vault.
        let market_key = market.key();
        let seeds: &[&[u8]] = &[b"market", market_key.as_ref(), &[market.bump]];
        let signer_seeds: &[&[&[u8]]] = &[seeds];
        let (from_vault, to_trader) = match Outcome::from_u8(outcome)? {
            Outcome::Yes => (
                ctx.accounts.yes_vault.to_account_info(),
                ctx.accounts.trader_yes.to_account_info(),
            ),
            Outcome::No => (
                ctx.accounts.no_vault.to_account_info(),
                ctx.accounts.trader_no.to_account_info(),
            ),
            _ => return err!(MarketError::InvalidOutcome),
        };
        token::transfer(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from: from_vault,
                    to: to_trader,
                    authority: market.to_account_info(),
                },
                signer_seeds,
            ),
            shares_out,
        )?;

        emit!(TradeExecuted {
            market: market.key(),
            trader: ctx.accounts.trader.key(),
            side: TradeSide::Buy as u8,
            outcome,
            amount_in,
            shares: shares_out,
            fee,
            yes_reserve_after: market.yes_reserve,
            no_reserve_after: market.no_reserve,
            ts: Clock::get()?.unix_timestamp,
        });
        Ok(())
    }

    /// Sell outcome shares back to the AMM for collateral.
    pub fn sell(ctx: Context<Trade>, outcome: u8, shares_in: u64, min_amount_out: u64) -> Result<()> {
        let market = &mut ctx.accounts.market;
        require!(market.state == MarketState::Open as u8, MarketError::MarketClosed);
        require!(Clock::get()?.unix_timestamp < market.close_ts, MarketError::TradingHalted);
        require!(shares_in > 0, MarketError::ZeroAmount);

        let (in_reserve, out_reserve) = match Outcome::from_u8(outcome)? {
            // Selling YES shares: YES reserve goes up, NO reserve goes down.
            Outcome::Yes => (market.yes_reserve, market.no_reserve),
            Outcome::No => (market.no_reserve, market.yes_reserve),
            _ => return err!(MarketError::InvalidOutcome),
        };

        let k = (in_reserve as u128).checked_mul(out_reserve as u128).ok_or(MarketError::MathOverflow)?;
        let new_in = (in_reserve as u128).checked_add(shares_in as u128).ok_or(MarketError::MathOverflow)?;
        let new_out = k.checked_div(new_in).ok_or(MarketError::MathOverflow)?;
        let gross_out_u128 = (out_reserve as u128).checked_sub(new_out).ok_or(MarketError::MathOverflow)?;
        let gross_out: u64 = gross_out_u128.try_into().map_err(|_| MarketError::MathOverflow)?;
        let fee = mul_div(gross_out, market.fee_bps as u64, BPS_DENOM)?;
        let amount_out = gross_out.checked_sub(fee).ok_or(MarketError::MathOverflow)?;
        require!(amount_out >= min_amount_out, MarketError::SlippageExceeded);

        // Pull shares from trader.
        let (to_vault, from_trader) = match Outcome::from_u8(outcome)? {
            Outcome::Yes => (
                ctx.accounts.yes_vault.to_account_info(),
                ctx.accounts.trader_yes.to_account_info(),
            ),
            Outcome::No => (
                ctx.accounts.no_vault.to_account_info(),
                ctx.accounts.trader_no.to_account_info(),
            ),
            _ => return err!(MarketError::InvalidOutcome),
        };
        token::transfer(
            CpiContext::new(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from: from_trader,
                    to: to_vault,
                    authority: ctx.accounts.trader.to_account_info(),
                },
            ),
            shares_in,
        )?;

        // Update reserves.
        match Outcome::from_u8(outcome)? {
            Outcome::Yes => {
                market.yes_reserve = new_in as u64;
                market.no_reserve = new_out as u64;
            }
            Outcome::No => {
                market.no_reserve = new_in as u64;
                market.yes_reserve = new_out as u64;
            }
            _ => return err!(MarketError::InvalidOutcome),
        }
        market.total_volume = market.total_volume.saturating_add(amount_out);

        // Payout collateral.
        let market_key = market.key();
        let seeds: &[&[u8]] = &[b"market", market_key.as_ref(), &[market.bump]];
        let signer_seeds: &[&[&[u8]]] = &[seeds];
        token::transfer(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.collateral_vault.to_account_info(),
                    to: ctx.accounts.trader_collateral.to_account_info(),
                    authority: market.to_account_info(),
                },
                signer_seeds,
            ),
            amount_out,
        )?;

        emit!(TradeExecuted {
            market: market.key(),
            trader: ctx.accounts.trader.key(),
            side: TradeSide::Sell as u8,
            outcome,
            amount_in: shares_in,
            shares: amount_out,
            fee,
            yes_reserve_after: market.yes_reserve,
            no_reserve_after: market.no_reserve,
            ts: Clock::get()?.unix_timestamp,
        });
        Ok(())
    }

    /// Oracle posts the winning outcome. Only callable after `close_ts`.
    pub fn resolve_market(ctx: Context<ResolveMarket>, winning_outcome: u8) -> Result<()> {
        let market = &mut ctx.accounts.market;
        require_keys_eq!(ctx.accounts.oracle.key(), market.oracle, MarketError::Unauthorized);
        require!(Clock::get()?.unix_timestamp >= market.close_ts, MarketError::MarketStillOpen);
        require!(market.state == MarketState::Open as u8, MarketError::AlreadyResolved);
        let outcome = Outcome::from_u8(winning_outcome)?;
        require!(
            matches!(outcome, Outcome::Yes | Outcome::No | Outcome::Invalid),
            MarketError::InvalidOutcome
        );

        market.state = MarketState::Resolved as u8;
        market.winning_outcome = winning_outcome;
        market.resolution_ts = Clock::get()?.unix_timestamp;

        emit!(MarketResolved {
            market: market.key(),
            winning_outcome,
            resolution_ts: market.resolution_ts,
        });
        Ok(())
    }

    /// After resolution, a holder of winning shares can redeem 1:1 collateral.
    /// If the market resolved `Invalid`, both YES and NO shares redeem 50/50.
    pub fn claim(ctx: Context<Claim>) -> Result<()> {
        let market = &ctx.accounts.market;
        require!(market.state == MarketState::Resolved as u8, MarketError::NotResolved);

        let yes_balance = ctx.accounts.trader_yes.amount;
        let no_balance = ctx.accounts.trader_no.amount;

        let payout = match Outcome::from_u8(market.winning_outcome)? {
            Outcome::Yes => yes_balance,
            Outcome::No => no_balance,
            Outcome::Invalid => yes_balance
                .checked_add(no_balance)
                .ok_or(MarketError::MathOverflow)?
                / 2,
            Outcome::Unresolved => return err!(MarketError::NotResolved),
        };
        require!(payout > 0, MarketError::NothingToClaim);

        // Burn-by-transfer: winning shares go to program vault.
        if yes_balance > 0 {
            token::transfer(
                CpiContext::new(
                    ctx.accounts.token_program.to_account_info(),
                    Transfer {
                        from: ctx.accounts.trader_yes.to_account_info(),
                        to: ctx.accounts.yes_vault.to_account_info(),
                        authority: ctx.accounts.trader.to_account_info(),
                    },
                ),
                yes_balance,
            )?;
        }
        if no_balance > 0 {
            token::transfer(
                CpiContext::new(
                    ctx.accounts.token_program.to_account_info(),
                    Transfer {
                        from: ctx.accounts.trader_no.to_account_info(),
                        to: ctx.accounts.no_vault.to_account_info(),
                        authority: ctx.accounts.trader.to_account_info(),
                    },
                ),
                no_balance,
            )?;
        }

        // Pay collateral out.
        let market_key = market.key();
        let seeds: &[&[u8]] = &[b"market", market_key.as_ref(), &[market.bump]];
        let signer_seeds: &[&[&[u8]]] = &[seeds];
        token::transfer(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.collateral_vault.to_account_info(),
                    to: ctx.accounts.trader_collateral.to_account_info(),
                    authority: market.to_account_info(),
                },
                signer_seeds,
            ),
            payout,
        )?;

        emit!(Claimed {
            market: market.key(),
            trader: ctx.accounts.trader.key(),
            payout,
            ts: Clock::get()?.unix_timestamp,
        });
        Ok(())
    }
}

// ---------------------------------------------------------------------------
// Accounts
// ---------------------------------------------------------------------------

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct InitializeMarketParams {
    pub question: String,
    pub oracle: Pubkey,
    pub close_ts: i64,
    pub fee_bps: u16,
    pub initial_yes_reserve: u64,
    pub initial_no_reserve: u64,
    pub nonce: u64, // allows multiple markets from same creator
}

#[derive(Accounts)]
#[instruction(params: InitializeMarketParams)]
pub struct InitializeMarket<'info> {
    #[account(mut)]
    pub creator: Signer<'info>,

    #[account(
        init,
        payer = creator,
        space = 8 + Market::MAX_SIZE,
        seeds = [b"market", creator.key().as_ref(), &params.nonce.to_le_bytes()],
        bump,
    )]
    pub market: Account<'info, Market>,

    pub collateral_mint: Account<'info, Mint>,
    pub yes_mint: Account<'info, Mint>,
    pub no_mint: Account<'info, Mint>,

    #[account(
        init,
        payer = creator,
        token::mint = collateral_mint,
        token::authority = market,
        seeds = [b"vault", market.key().as_ref(), b"collateral"],
        bump,
    )]
    pub collateral_vault: Account<'info, TokenAccount>,

    #[account(
        init,
        payer = creator,
        token::mint = yes_mint,
        token::authority = market,
        seeds = [b"vault", market.key().as_ref(), b"yes"],
        bump,
    )]
    pub yes_vault: Account<'info, TokenAccount>,

    #[account(
        init,
        payer = creator,
        token::mint = no_mint,
        token::authority = market,
        seeds = [b"vault", market.key().as_ref(), b"no"],
        bump,
    )]
    pub no_vault: Account<'info, TokenAccount>,

    #[account(mut, token::mint = collateral_mint, token::authority = creator)]
    pub creator_collateral: Account<'info, TokenAccount>,

    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
    pub rent: Sysvar<'info, Rent>,
}

#[derive(Accounts)]
pub struct Trade<'info> {
    #[account(mut)]
    pub trader: Signer<'info>,

    #[account(mut, has_one = collateral_vault, has_one = yes_vault, has_one = no_vault)]
    pub market: Account<'info, Market>,

    #[account(mut)]
    pub collateral_vault: Account<'info, TokenAccount>,
    #[account(mut)]
    pub yes_vault: Account<'info, TokenAccount>,
    #[account(mut)]
    pub no_vault: Account<'info, TokenAccount>,

    #[account(mut, token::authority = trader)]
    pub trader_collateral: Account<'info, TokenAccount>,
    #[account(mut, token::authority = trader)]
    pub trader_yes: Account<'info, TokenAccount>,
    #[account(mut, token::authority = trader)]
    pub trader_no: Account<'info, TokenAccount>,

    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct ResolveMarket<'info> {
    pub oracle: Signer<'info>,
    #[account(mut)]
    pub market: Account<'info, Market>,
}

#[derive(Accounts)]
pub struct Claim<'info> {
    #[account(mut)]
    pub trader: Signer<'info>,

    #[account(has_one = collateral_vault, has_one = yes_vault, has_one = no_vault)]
    pub market: Account<'info, Market>,

    #[account(mut)]
    pub collateral_vault: Account<'info, TokenAccount>,
    #[account(mut)]
    pub yes_vault: Account<'info, TokenAccount>,
    #[account(mut)]
    pub no_vault: Account<'info, TokenAccount>,

    #[account(mut, token::authority = trader)]
    pub trader_collateral: Account<'info, TokenAccount>,
    #[account(mut, token::authority = trader)]
    pub trader_yes: Account<'info, TokenAccount>,
    #[account(mut, token::authority = trader)]
    pub trader_no: Account<'info, TokenAccount>,

    pub token_program: Program<'info, Token>,
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

#[account]
pub struct Market {
    pub bump: u8,
    pub state: u8,
    pub winning_outcome: u8,
    pub _pad: [u8; 5],
    pub fee_bps: u16,
    pub creator: Pubkey,
    pub oracle: Pubkey,
    pub collateral_mint: Pubkey,
    pub collateral_vault: Pubkey,
    pub yes_vault: Pubkey,
    pub no_vault: Pubkey,
    pub yes_reserve: u64,
    pub no_reserve: u64,
    pub total_volume: u64,
    pub close_ts: i64,
    pub resolution_ts: i64,
    pub question: String,
    pub nonce: u64,
}

impl Market {
    // Rough upper bound: 1 + 1 + 1 + 5 + 2 + 32*6 + 8*5 + 4 + 256 + 8
    pub const MAX_SIZE: usize = 1 + 1 + 1 + 5 + 2 + 32 * 6 + 8 * 5 + 4 + 256 + 8;
}

#[repr(u8)]
#[derive(Clone, Copy, AnchorSerialize, AnchorDeserialize)]
pub enum MarketState {
    Open = 0,
    Resolved = 1,
}

#[repr(u8)]
#[derive(Clone, Copy, AnchorSerialize, AnchorDeserialize)]
pub enum Outcome {
    Unresolved = 0,
    Yes = 1,
    No = 2,
    Invalid = 3,
}

impl Outcome {
    pub fn from_u8(v: u8) -> Result<Self> {
        match v {
            0 => Ok(Outcome::Unresolved),
            1 => Ok(Outcome::Yes),
            2 => Ok(Outcome::No),
            3 => Ok(Outcome::Invalid),
            _ => err!(MarketError::InvalidOutcome),
        }
    }
}

#[repr(u8)]
#[derive(Clone, Copy, AnchorSerialize, AnchorDeserialize)]
pub enum TradeSide {
    Buy = 0,
    Sell = 1,
}

// ---------------------------------------------------------------------------
// Events — consumed by the off-chain indexer.
// ---------------------------------------------------------------------------

#[event]
pub struct MarketInitialized {
    pub market: Pubkey,
    pub creator: Pubkey,
    pub oracle: Pubkey,
    pub collateral_mint: Pubkey,
    pub yes_reserve: u64,
    pub no_reserve: u64,
    pub close_ts: i64,
    pub fee_bps: u16,
    pub question: String,
}

#[event]
pub struct TradeExecuted {
    pub market: Pubkey,
    pub trader: Pubkey,
    pub side: u8,
    pub outcome: u8,
    pub amount_in: u64,
    pub shares: u64,
    pub fee: u64,
    pub yes_reserve_after: u64,
    pub no_reserve_after: u64,
    pub ts: i64,
}

#[event]
pub struct MarketResolved {
    pub market: Pubkey,
    pub winning_outcome: u8,
    pub resolution_ts: i64,
}

#[event]
pub struct Claimed {
    pub market: Pubkey,
    pub trader: Pubkey,
    pub payout: u64,
    pub ts: i64,
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

#[error_code]
pub enum MarketError {
    #[msg("Fee exceeds the 5% hard cap.")]
    FeeTooHigh,
    #[msg("Close timestamp must be in the future.")]
    CloseInPast,
    #[msg("Initial liquidity must be non-zero on both sides.")]
    ZeroLiquidity,
    #[msg("Market is not open for trading.")]
    MarketClosed,
    #[msg("Trading halted: market past close_ts.")]
    TradingHalted,
    #[msg("Zero amount.")]
    ZeroAmount,
    #[msg("Slippage tolerance exceeded.")]
    SlippageExceeded,
    #[msg("Math overflow.")]
    MathOverflow,
    #[msg("Invalid outcome value.")]
    InvalidOutcome,
    #[msg("Only the configured oracle may resolve this market.")]
    Unauthorized,
    #[msg("Market has not reached close_ts.")]
    MarketStillOpen,
    #[msg("Market is already resolved.")]
    AlreadyResolved,
    #[msg("Market is not resolved.")]
    NotResolved,
    #[msg("No winning balance to claim.")]
    NothingToClaim,
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

fn mul_div(a: u64, b: u64, denom: u64) -> Result<u64> {
    let r = (a as u128)
        .checked_mul(b as u128)
        .and_then(|v| v.checked_div(denom as u128))
        .ok_or(MarketError::MathOverflow)?;
    r.try_into().map_err(|_| MarketError::MathOverflow.into())
}
