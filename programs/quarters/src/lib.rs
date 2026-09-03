// QUARTERS cashier — the chain is the till and the trophy case, never the game.
// Quarters split 70/15/15 (pot/operator/treasury) at insert_coin, with the
// run's seed committed before play. Scores enter only via the verifier's
// signature; every scoring replay is published off-chain so any player can
// re-execute the verifier's work. Daily pots settle permissionlessly.
use anchor_lang::prelude::*;
use anchor_lang::system_program::{transfer, Transfer};

pub const SUBMIT_WINDOW: i64 = 1200;   // seconds from insert_coin to submit_score
pub const SETTLE_GRACE: i64 = 1260;    // ≥ SUBMIT_WINDOW + margin: a run can never find its pot already settled (capped at period/4)

// The most recent slot hash, unknowable before the coin lands: mixed into the
// engine seed so nobody can shop for a lucky seed offline.
fn recent_slot_salt(slot_hashes: &AccountInfo) -> Result<[u8; 8]> {
    let data = slot_hashes.try_borrow_data()?;
    // layout: u64 len, then entries of (u64 slot, [u8;32] hash), most recent first
    require!(data.len() >= 8 + 8 + 32, QuartersError::WrongWinnerAccounts);
    let mut salt = [0u8; 8];
    salt.copy_from_slice(&data[16..24]);
    Ok(salt)
}

declare_id!("GixGVpDZpCxVcnpfWcSPwXF8rtjYrBGmmpkSdZq7kb7a");

pub const TOP_N: usize = 10;
// 30 / 18 / 12, then 4th-10th split the remaining 40% evenly.
pub const PODIUM_BPS: [u64; 3] = [3000, 1800, 1200];
pub const TAIL_BPS_TOTAL: u64 = 4000;

#[program]
pub mod quarters {
    use super::*;

    pub fn initialize(
        ctx: Context<Initialize>,
        verifier: Pubkey,
        treasury: Pubkey,
        quarter_lamports: u64,
        pot_bps: u16,
        operator_bps: u16,
        period_seconds: u32,
    ) -> Result<()> {
        require!(period_seconds >= 60, QuartersError::BadSplits);
        require!(
            (pot_bps as u64) + (operator_bps as u64) <= 10_000,
            QuartersError::BadSplits
        );
        let a = &mut ctx.accounts.arcade;
        a.authority = ctx.accounts.authority.key();
        a.verifier = verifier;
        a.treasury = treasury;
        a.quarter_lamports = quarter_lamports;
        a.pot_bps = pot_bps;
        a.operator_bps = operator_bps;
        a.period_seconds = period_seconds;
        a.credit_counter = 0;
        a.bump = ctx.bumps.arcade;
        Ok(())
    }

    pub fn create_cabinet(
        ctx: Context<CreateCabinet>,
        id: u8,
        game: [u8; 16],
        is_bounty: bool,
    ) -> Result<()> {
        let c = &mut ctx.accounts.cabinet;
        c.id = id;
        c.game = game;
        c.operator = ctx.accounts.arcade.treasury; // house-owned until a deed sells
        c.is_bounty = is_bounty;
        c.bump = ctx.bumps.cabinet;
        Ok(())
    }

    pub fn update_config(
        ctx: Context<UpdateConfig>,
        verifier: Pubkey,
        treasury: Pubkey,
        quarter_lamports: u64,
        pot_bps: u16,
        operator_bps: u16,
        period_seconds: u32,
    ) -> Result<()> {
        require!(
            (pot_bps as u64) + (operator_bps as u64) <= 10_000,
            QuartersError::BadSplits
        );
        require!(period_seconds >= 60, QuartersError::BadSplits);
        let a = &mut ctx.accounts.arcade;
        a.verifier = verifier;
        a.treasury = treasury;
        a.quarter_lamports = quarter_lamports;
        a.pot_bps = pot_bps;
        a.operator_bps = operator_bps;
        a.period_seconds = period_seconds;
        Ok(())
    }

    // The deed hook: when cabinet NFTs sell, the holder is set as operator.
    pub fn set_operator(ctx: Context<SetOperator>, new_operator: Pubkey) -> Result<()> {
        ctx.accounts.cabinet.operator = new_operator;
        Ok(())
    }

    pub fn insert_coin(ctx: Context<InsertCoin>, seed_commit: [u8; 32]) -> Result<()> {
        // Every cabinet has a Stakes account (its price). No optional path:
        // a client cannot pay the floor price into a back-room pot.
        require!(ctx.accounts.stakes.cabinet_id == ctx.accounts.cabinet.id, QuartersError::WrongWinnerAccounts);
        let quarter = ctx.accounts.stakes.price;
        let pot_cut = quarter * ctx.accounts.arcade.pot_bps as u64 / 10_000;
        let op_cut = quarter * ctx.accounts.arcade.operator_bps as u64 / 10_000;
        let house_cut = quarter - pot_cut - op_cut;

        require_keys_eq!(
            ctx.accounts.operator.key(),
            ctx.accounts.cabinet.operator,
            QuartersError::WrongOperator
        );
        require_keys_eq!(
            ctx.accounts.treasury.key(),
            ctx.accounts.arcade.treasury,
            QuartersError::WrongTreasury
        );

        let day = (Clock::get()?.unix_timestamp / ctx.accounts.arcade.period_seconds as i64) as u32;

        // Pot share goes to the bounty pool or the day's pot.
        let pot_dest = if ctx.accounts.cabinet.is_bounty {
            let b = &mut ctx.accounts.bounty;
            if b.cabinet_id == 0 && b.record == 0 && b.champion == Pubkey::default() {
                b.cabinet_id = ctx.accounts.cabinet.id;
            }
            ctx.accounts.bounty.to_account_info()
        } else {
            let p = &mut ctx.accounts.pot;
            if !p.initialized {
                p.initialized = true;
                p.cabinet_id = ctx.accounts.cabinet.id;
                p.day = day;
                p.count = 0;
                p.settled = false;
                p.rent_payer = ctx.accounts.player.key();
            }
            require!(p.day == day, QuartersError::WrongDay);
            ctx.accounts.pot.to_account_info()
        };

        for (dest, lamports) in [
            (pot_dest, pot_cut),
            (ctx.accounts.operator.to_account_info(), op_cut),
            (ctx.accounts.treasury.to_account_info(), house_cut),
        ] {
            transfer(
                CpiContext::new(
                    ctx.accounts.system_program.to_account_info(),
                    Transfer {
                        from: ctx.accounts.player.to_account_info(),
                        to: dest,
                    },
                ),
                lamports,
            )?;
        }

        let cr = &mut ctx.accounts.credit;
        cr.player = ctx.accounts.player.key();
        cr.cabinet_id = ctx.accounts.cabinet.id;
        cr.day = day;
        cr.seed_commit = seed_commit;
        cr.consumed = false;
        cr.index = ctx.accounts.arcade.credit_counter;
        cr.bump = ctx.bumps.credit;
        cr.rent_payer = ctx.accounts.player.key();
        cr.inserted_at = Clock::get()?.unix_timestamp;
        cr.salt = recent_slot_salt(&ctx.accounts.slot_hashes)?;
        ctx.accounts.arcade.credit_counter += 1;

        emit!(CoinInserted {
            player: cr.player,
            cabinet_id: cr.cabinet_id,
            credit_index: cr.index,
            seed_commit,
            day,
        });
        Ok(())
    }

    // Open (or top up) a credit tab: one wallet popup buys a session of
    // popup-free plays. The tab escrows lamports; the session key may only
    // spend them into games whose payouts go to the tab's owner. Unused
    // balance is refundable via close_tab at any time.
    // deposit = escrow for plays; fee_float (taken FROM the deposit) funds the
    // session key's tx fees so the player's wallet never sends SOL to an
    // unknown address directly (wallet simulators flag that as a drainer).
    pub fn open_tab(ctx: Context<OpenTab>, deposit: u64, fee_float: u64) -> Result<()> {
        require!(fee_float <= deposit, QuartersError::TabEmpty);
        let t = &mut ctx.accounts.tab;
        t.player = ctx.accounts.player.key();
        t.session_key = ctx.accounts.session_key.key();
        t.bump = ctx.bumps.tab;
        if deposit > 0 {
            transfer(
                CpiContext::new(
                    ctx.accounts.system_program.to_account_info(),
                    Transfer {
                        from: ctx.accounts.player.to_account_info(),
                        to: ctx.accounts.tab.to_account_info(),
                    },
                ),
                deposit,
            )?;
        }
        if fee_float > 0 {
            **ctx.accounts.tab.to_account_info().try_borrow_mut_lamports()? -= fee_float;
            **ctx.accounts.session_key.to_account_info().try_borrow_mut_lamports()? += fee_float;
        }
        Ok(())
    }

    // Session-signed insert coin: debits one quarter from the tab and splits
    // it exactly like insert_coin. Committing a seed costs a credit, so seed
    // re-rolling is as expensive here as with a wallet popup.
    pub fn start_run(ctx: Context<StartRun>, seed_commit: [u8; 32]) -> Result<()> {
        let signer = ctx.accounts.signer.key();
        require!(
            signer == ctx.accounts.tab.session_key || signer == ctx.accounts.tab.player,
            QuartersError::NotSession
        );
        require_keys_eq!(
            ctx.accounts.operator.key(),
            ctx.accounts.cabinet.operator,
            QuartersError::WrongOperator
        );
        require_keys_eq!(
            ctx.accounts.treasury.key(),
            ctx.accounts.arcade.treasury,
            QuartersError::WrongTreasury
        );

        // Every cabinet has a Stakes account (its price). No optional path:
        // a client cannot pay the floor price into a back-room pot.
        require!(ctx.accounts.stakes.cabinet_id == ctx.accounts.cabinet.id, QuartersError::WrongWinnerAccounts);
        let quarter = ctx.accounts.stakes.price;
        let pot_cut = quarter * ctx.accounts.arcade.pot_bps as u64 / 10_000;
        let op_cut = quarter * ctx.accounts.arcade.operator_bps as u64 / 10_000;
        let house_cut = quarter - pot_cut - op_cut;

        // The tab must keep its own rent and cover the quarter.
        let tab_min = Rent::get()?.minimum_balance(8 + Tab::INIT_SPACE);
        let available = ctx
            .accounts
            .tab
            .to_account_info()
            .lamports()
            .saturating_sub(tab_min);
        require!(available >= quarter, QuartersError::TabEmpty);

        let day = (Clock::get()?.unix_timestamp / ctx.accounts.arcade.period_seconds as i64) as u32;
        let pot_dest = if ctx.accounts.cabinet.is_bounty {
            let b = &mut ctx.accounts.bounty;
            if b.cabinet_id == 0 && b.record == 0 && b.champion == Pubkey::default() {
                b.cabinet_id = ctx.accounts.cabinet.id;
            }
            ctx.accounts.bounty.to_account_info()
        } else {
            let pd = &mut ctx.accounts.pot;
            if !pd.initialized {
                pd.initialized = true;
                pd.cabinet_id = ctx.accounts.cabinet.id;
                pd.day = day;
                pd.count = 0;
                pd.settled = false;
                pd.rent_payer = ctx.accounts.signer.key();
            }
            require!(pd.day == day, QuartersError::WrongDay);
            ctx.accounts.pot.to_account_info()
        };

        // Tab is program-owned: split by direct lamport arithmetic.
        **ctx.accounts.tab.to_account_info().try_borrow_mut_lamports()? -= quarter;
        **pot_dest.try_borrow_mut_lamports()? += pot_cut;
        **ctx.accounts.operator.to_account_info().try_borrow_mut_lamports()? += op_cut;
        **ctx.accounts.treasury.to_account_info().try_borrow_mut_lamports()? += house_cut;

        let cr = &mut ctx.accounts.credit;
        cr.player = ctx.accounts.tab.player;
        cr.cabinet_id = ctx.accounts.cabinet.id;
        cr.day = day;
        cr.seed_commit = seed_commit;
        cr.consumed = false;
        cr.index = ctx.accounts.arcade.credit_counter;
        cr.bump = ctx.bumps.credit;
        cr.rent_payer = signer;
        cr.inserted_at = Clock::get()?.unix_timestamp;
        cr.salt = recent_slot_salt(&ctx.accounts.slot_hashes)?;
        ctx.accounts.arcade.credit_counter += 1;

        emit!(CoinInserted {
            player: cr.player,
            cabinet_id: cr.cabinet_id,
            credit_index: cr.index,
            seed_commit,
            day,
        });
        Ok(())
    }

    // Refund every unused lamport (and the tab's own rent) to the player.
    pub fn close_tab(_ctx: Context<CloseTab>) -> Result<()> {
        Ok(())
    }

    // Verifier-signed: the score was recomputed from the credit's committed
    // seed and the published input log whose hash is replay_hash.
    pub fn submit_score(ctx: Context<SubmitScore>, score: u32, replay_hash: [u8; 32]) -> Result<()> {
        let credit = &mut ctx.accounts.credit;
        require!(!credit.consumed, QuartersError::CreditConsumed);
        // A run must be verified within SUBMIT_WINDOW of paying: a max-length
        // run is 10 minutes, so a tool-assisted replay has to be produced live.
        require!(Clock::get()?.unix_timestamp <= credit.inserted_at + SUBMIT_WINDOW, QuartersError::SubmitWindow);
        credit.consumed = true;

        let pot = &mut ctx.accounts.pot;
        require!(!pot.settled, QuartersError::PotSettled);
        require!(pot.day == credit.day, QuartersError::WrongDay);
        require!(pot.cabinet_id == credit.cabinet_id, QuartersError::WrongCabinet);

        // Insert into the top-10, sorted descending, ties to the earlier score.
        let entry = PotEntry {
            player: credit.player,
            score,
            replay_hash,
        };
        let n = pot.count as usize;
        let mut pos = n;
        for i in 0..n {
            if score > pot.entries[i].score {
                pos = i;
                break;
            }
        }
        if pos < TOP_N {
            let last = core::cmp::min(n, TOP_N - 1);
            let mut i = last;
            while i > pos {
                pot.entries[i] = pot.entries[i - 1];
                i -= 1;
            }
            pot.entries[pos] = entry;
            if (pot.count as usize) < TOP_N {
                pot.count += 1;
            }
        }

        emit!(ScoreSubmitted {
            player: credit.player,
            cabinet_id: credit.cabinet_id,
            credit_index: credit.index,
            score,
            replay_hash,
            day: credit.day,
        });
        Ok(())
    }

    // Verifier-signed: score beats the standing record — winner takes the pool.
    pub fn claim_bounty(ctx: Context<ClaimBounty>, score: u32, replay_hash: [u8; 32]) -> Result<()> {
        let credit = &mut ctx.accounts.credit;
        require!(!credit.consumed, QuartersError::CreditConsumed);
        // A run must be verified within SUBMIT_WINDOW of paying: a max-length
        // run is 10 minutes, so a tool-assisted replay has to be produced live.
        require!(Clock::get()?.unix_timestamp <= credit.inserted_at + SUBMIT_WINDOW, QuartersError::SubmitWindow);
        credit.consumed = true;

        let bounty = &mut ctx.accounts.bounty;
        require!(score > bounty.record, QuartersError::RecordStands);
        require_keys_eq!(
            ctx.accounts.player.key(),
            credit.player,
            QuartersError::WrongPlayer
        );

        let rent = Rent::get()?.minimum_balance(8 + Bounty::INIT_SPACE);
        let pool = ctx
            .accounts
            .bounty
            .to_account_info()
            .lamports()
            .saturating_sub(rent);

        **ctx
            .accounts
            .bounty
            .to_account_info()
            .try_borrow_mut_lamports()? -= pool;
        **ctx
            .accounts
            .player
            .to_account_info()
            .try_borrow_mut_lamports()? += pool;

        let bounty = &mut ctx.accounts.bounty;
        bounty.record = score;
        bounty.champion = credit.player;
        bounty.record_replay = replay_hash;

        emit!(BountyClaimed {
            player: credit.player,
            cabinet_id: credit.cabinet_id,
            score,
            paid: pool,
            replay_hash,
        });
        Ok(())
    }

    // Permissionless once the day has rolled over. Remaining accounts must be
    // the leaderboard wallets, in order; leftovers go to the treasury.
    pub fn settle_pot(ctx: Context<SettlePot>) -> Result<()> {
        let now_day = (Clock::get()?.unix_timestamp / ctx.accounts.arcade.period_seconds as i64) as u32;
        let pot = &mut ctx.accounts.pot;
        require!(!pot.settled, QuartersError::PotSettled);
        // Grace after the period ends so runs started at the buzzer can still
        // land (a run is up to 10 minutes; verifier latency on top).
        let period = ctx.accounts.arcade.period_seconds as i64;
        let grace = core::cmp::min(SETTLE_GRACE, period / 4);
        require!(now_day > pot.day, QuartersError::DayNotOver);
        require!(Clock::get()?.unix_timestamp >= (pot.day as i64 + 1) * period + grace, QuartersError::DayNotOver);
        pot.settled = true;

        let rent = Rent::get()?.minimum_balance(8 + DailyPot::INIT_SPACE);
        let pool = ctx
            .accounts
            .pot
            .to_account_info()
            .lamports()
            .saturating_sub(rent);

        let n = ctx.accounts.pot.count as usize;
        require!(
            ctx.remaining_accounts.len() == n,
            QuartersError::WrongWinnerAccounts
        );

        // The players present split the whole pool in the table's proportions:
        // one player takes it all, two split 3000:1800, and so on. Only
        // rounding dust falls through to the treasury.
        let rank_bps = |i: usize| -> u64 { if i < 3 { PODIUM_BPS[i] } else { TAIL_BPS_TOTAL / 7 } };
        let present_bps: u64 = (0..n).map(rank_bps).sum();
        let mut paid_total: u64 = 0;
        for (i, winner) in ctx.remaining_accounts.iter().enumerate() {
            require_keys_eq!(
                winner.key(),
                ctx.accounts.pot.entries[i].player,
                QuartersError::WrongWinnerAccounts
            );
            let bps = rank_bps(i);
            let amount = if present_bps == 0 { 0 } else { pool * bps / present_bps };
            **ctx.accounts.pot.to_account_info().try_borrow_mut_lamports()? -= amount;
            **winner.try_borrow_mut_lamports()? += amount;
            paid_total += amount;
        }

        // Whatever the split table didn't allocate (short leaderboards,
        // rounding) goes to the treasury.
        require_keys_eq!(
            ctx.accounts.treasury.key(),
            ctx.accounts.arcade.treasury,
            QuartersError::WrongTreasury
        );
        let leftover = pool - paid_total;
        if leftover > 0 {
            **ctx.accounts.pot.to_account_info().try_borrow_mut_lamports()? -= leftover;
            **ctx
                .accounts
                .treasury
                .to_account_info()
                .try_borrow_mut_lamports()? += leftover;
        }

        emit!(PotSettledEvent {
            cabinet_id: ctx.accounts.pot.cabinet_id,
            day: ctx.accounts.pot.day,
            pool,
            winners: ctx.accounts.pot.count,
        });
        Ok(())
    }

    // Per-cabinet stake override (the backroom): the authority prices a
    // cabinet; insert_coin/start_run that pass the Stakes account pay it.
    pub fn set_stakes(ctx: Context<SetStakes>, cabinet_id: u8, price: u64) -> Result<()> {
        require!(price > 0, QuartersError::RecordStands);
        let st = &mut ctx.accounts.stakes;
        st.cabinet_id = cabinet_id;
        st.price = price;
        st.bump = ctx.bumps.stakes;
        Ok(())
    }

    // Pre-create a cabinet's pot for a period so the first player of the day
    // doesn't pay its rent. Anyone may call it; the settle daemon does.
    pub fn open_pot(ctx: Context<OpenPot>, day: u32) -> Result<()> {
        let now_day = (Clock::get()?.unix_timestamp / ctx.accounts.arcade.period_seconds as i64) as u32;
        require!(day >= now_day && day <= now_day + 2, QuartersError::WrongDay);
        let pd = &mut ctx.accounts.pot;
        if !pd.initialized {
            pd.initialized = true;
            pd.cabinet_id = ctx.accounts.cabinet.id;
            pd.day = day;
            pd.count = 0;
            pd.settled = false;
            pd.rent_payer = ctx.accounts.payer.key();
        }
        Ok(())
    }

    // A credit that was never submitted within SUBMIT_WINDOW can be closed by
    // anyone; its rent goes back to whoever fronted it. The quarter itself
    // was already split at insert time.
    pub fn close_expired_credit(ctx: Context<CloseExpiredCredit>) -> Result<()> {
        let credit = &ctx.accounts.credit;
        require!(!credit.consumed, QuartersError::CreditConsumed);
        require!(Clock::get()?.unix_timestamp > credit.inserted_at + SUBMIT_WINDOW, QuartersError::SubmitWindow);
        Ok(())
    }
}

// ---------- state ----------

#[account]
#[derive(InitSpace)]
pub struct Arcade {
    pub authority: Pubkey,
    pub verifier: Pubkey,
    pub treasury: Pubkey,
    pub quarter_lamports: u64,
    pub pot_bps: u16,
    pub operator_bps: u16,
    pub period_seconds: u32,
    pub credit_counter: u64,
    pub bump: u8,
}

#[account]
#[derive(InitSpace)]
pub struct Cabinet {
    pub id: u8,
    pub game: [u8; 16],
    pub operator: Pubkey,
    pub is_bounty: bool,
    pub bump: u8,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, InitSpace, Default)]
pub struct PotEntry {
    pub player: Pubkey,
    pub score: u32,
    pub replay_hash: [u8; 32],
}

#[account]
#[derive(InitSpace)]
pub struct DailyPot {
    pub initialized: bool,
    pub cabinet_id: u8,
    pub day: u32,
    pub settled: bool,
    pub count: u8,
    pub entries: [PotEntry; 10],
    pub rent_payer: Pubkey,
}

#[account]
#[derive(InitSpace)]
pub struct Bounty {
    pub cabinet_id: u8,
    pub record: u32,
    pub champion: Pubkey,
    pub record_replay: [u8; 32],
}

#[account]
#[derive(InitSpace)]
pub struct Credit {
    pub player: Pubkey,
    pub cabinet_id: u8,
    pub day: u32,
    pub seed_commit: [u8; 32],
    pub consumed: bool,
    pub index: u64,
    pub bump: u8,
    pub rent_payer: Pubkey,
    pub inserted_at: i64,
    pub salt: [u8; 8],
}

#[account]
#[derive(InitSpace)]
pub struct Tab {
    pub player: Pubkey,
    pub session_key: Pubkey,
    pub bump: u8,
}

// ---------- contexts ----------

#[derive(Accounts)]
pub struct Initialize<'info> {
    #[account(
        init,
        payer = authority,
        space = 8 + Arcade::INIT_SPACE,
        seeds = [b"arcade"],
        bump
    )]
    pub arcade: Account<'info, Arcade>,
    #[account(mut)]
    pub authority: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(id: u8)]
pub struct CreateCabinet<'info> {
    #[account(seeds = [b"arcade"], bump = arcade.bump, has_one = authority)]
    pub arcade: Account<'info, Arcade>,
    #[account(
        init,
        payer = authority,
        space = 8 + Cabinet::INIT_SPACE,
        seeds = [b"cabinet".as_ref(), &[id]],
        bump
    )]
    pub cabinet: Account<'info, Cabinet>,
    #[account(mut)]
    pub authority: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct SetOperator<'info> {
    #[account(seeds = [b"arcade"], bump = arcade.bump, has_one = authority)]
    pub arcade: Account<'info, Arcade>,
    #[account(mut, seeds = [b"cabinet".as_ref(), &[cabinet.id]], bump = cabinet.bump)]
    pub cabinet: Account<'info, Cabinet>,
    pub authority: Signer<'info>,
}

#[derive(Accounts)]
#[instruction(seed_commit: [u8; 32])]
pub struct InsertCoin<'info> {
    #[account(mut, seeds = [b"arcade"], bump = arcade.bump)]
    pub arcade: Account<'info, Arcade>,
    #[account(seeds = [b"cabinet".as_ref(), &[cabinet.id]], bump = cabinet.bump)]
    pub cabinet: Account<'info, Cabinet>,
    #[account(
        init_if_needed,
        payer = player,
        space = 8 + DailyPot::INIT_SPACE,
        seeds = [
            b"pot".as_ref(),
            &[cabinet.id],
            &((Clock::get()?.unix_timestamp / arcade.period_seconds as i64) as u32).to_le_bytes()
        ],
        bump
    )]
    pub pot: Box<Account<'info, DailyPot>>,
    #[account(
        init_if_needed,
        payer = player,
        space = 8 + Bounty::INIT_SPACE,
        seeds = [b"bounty".as_ref(), &[cabinet.id]],
        bump
    )]
    pub bounty: Box<Account<'info, Bounty>>,
    #[account(
        init,
        payer = player,
        space = 8 + Credit::INIT_SPACE,
        seeds = [b"credit".as_ref(), player.key().as_ref(), &seed_commit],
        bump
    )]
    pub credit: Box<Account<'info, Credit>>,
    #[account(mut)]
    pub player: Signer<'info>,
    /// CHECK: validated against cabinet.operator in the handler
    #[account(mut)]
    pub operator: UncheckedAccount<'info>,
    /// CHECK: validated against arcade.treasury in the handler
    #[account(mut)]
    pub treasury: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
    #[account(seeds = [b"stakes".as_ref(), &[cabinet.id]], bump = stakes.bump)]
    pub stakes: Account<'info, Stakes>,
    /// CHECK: the SlotHashes sysvar, address-checked
    #[account(address = anchor_lang::solana_program::sysvar::slot_hashes::ID)]
    pub slot_hashes: UncheckedAccount<'info>,
}

#[derive(Accounts)]
pub struct SubmitScore<'info> {
    #[account(seeds = [b"arcade"], bump = arcade.bump)]
    pub arcade: Account<'info, Arcade>,
    #[account(constraint = verifier.key() == arcade.verifier @ QuartersError::NotVerifier)]
    pub verifier: Signer<'info>,
    #[account(
        mut,
        close = rent_payer,
        seeds = [b"credit".as_ref(), credit.player.as_ref(), &credit.seed_commit],
        bump = credit.bump
    )]
    pub credit: Account<'info, Credit>,
    #[account(
        mut,
        seeds = [b"pot".as_ref(), &[credit.cabinet_id], &credit.day.to_le_bytes()],
        bump
    )]
    pub pot: Account<'info, DailyPot>,
    /// CHECK: rent refund destination; must be whoever fronted the rent
    #[account(mut, constraint = rent_payer.key() == credit.rent_payer @ QuartersError::WrongPlayer)]
    pub rent_payer: UncheckedAccount<'info>,
}

#[derive(Accounts)]
pub struct UpdateConfig<'info> {
    #[account(mut, seeds = [b"arcade"], bump = arcade.bump, has_one = authority)]
    pub arcade: Account<'info, Arcade>,
    pub authority: Signer<'info>,
}

#[derive(Accounts)]
pub struct ClaimBounty<'info> {
    #[account(seeds = [b"arcade"], bump = arcade.bump)]
    pub arcade: Account<'info, Arcade>,
    #[account(constraint = verifier.key() == arcade.verifier @ QuartersError::NotVerifier)]
    pub verifier: Signer<'info>,
    #[account(
        mut,
        close = rent_payer,
        seeds = [b"credit".as_ref(), credit.player.as_ref(), &credit.seed_commit],
        bump = credit.bump
    )]
    pub credit: Account<'info, Credit>,
    #[account(mut, seeds = [b"bounty".as_ref(), &[credit.cabinet_id]], bump)]
    pub bounty: Account<'info, Bounty>,
    /// CHECK: must match credit.player; receives the pool
    #[account(mut)]
    pub player: UncheckedAccount<'info>,
    /// CHECK: rent refund destination; must be whoever fronted the rent
    #[account(mut, constraint = rent_payer.key() == credit.rent_payer @ QuartersError::WrongPlayer)]
    pub rent_payer: UncheckedAccount<'info>,
}

#[derive(Accounts)]
pub struct SettlePot<'info> {
    #[account(seeds = [b"arcade"], bump = arcade.bump)]
    pub arcade: Account<'info, Arcade>,
    // Closed after paying out: the pot's rent goes back to the treasury, so
    // pre-opening pots (open_pot) costs the house nothing over time.
    #[account(
        mut,
        seeds = [b"pot".as_ref(), &[pot.cabinet_id], &pot.day.to_le_bytes()],
        bump,
        close = pot_rent_payer
    )]
    pub pot: Account<'info, DailyPot>,
    /// CHECK: validated against arcade.treasury in the handler
    #[account(mut)]
    pub treasury: UncheckedAccount<'info>,
    /// CHECK: whoever paid the pot's rent (open_pot payer or first player) gets it back
    #[account(mut, constraint = pot_rent_payer.key() == pot.rent_payer @ QuartersError::WrongWinnerAccounts)]
    pub pot_rent_payer: UncheckedAccount<'info>,
}

#[derive(Accounts)]
pub struct OpenTab<'info> {
    #[account(
        init_if_needed,
        payer = player,
        space = 8 + Tab::INIT_SPACE,
        seeds = [b"tab".as_ref(), player.key().as_ref()],
        bump
    )]
    pub tab: Account<'info, Tab>,
    #[account(mut)]
    pub player: Signer<'info>,
    /// CHECK: the throwaway session signer; receives the fee float
    #[account(mut)]
    pub session_key: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(seed_commit: [u8; 32])]
pub struct StartRun<'info> {
    #[account(mut, seeds = [b"arcade"], bump = arcade.bump)]
    pub arcade: Account<'info, Arcade>,
    #[account(seeds = [b"cabinet".as_ref(), &[cabinet.id]], bump = cabinet.bump)]
    pub cabinet: Account<'info, Cabinet>,
    #[account(mut, seeds = [b"tab".as_ref(), tab.player.as_ref()], bump = tab.bump)]
    pub tab: Box<Account<'info, Tab>>,
    #[account(
        init_if_needed,
        payer = signer,
        space = 8 + DailyPot::INIT_SPACE,
        seeds = [
            b"pot".as_ref(),
            &[cabinet.id],
            &((Clock::get()?.unix_timestamp / arcade.period_seconds as i64) as u32).to_le_bytes()
        ],
        bump
    )]
    pub pot: Box<Account<'info, DailyPot>>,
    #[account(
        init_if_needed,
        payer = signer,
        space = 8 + Bounty::INIT_SPACE,
        seeds = [b"bounty".as_ref(), &[cabinet.id]],
        bump
    )]
    pub bounty: Box<Account<'info, Bounty>>,
    #[account(
        init,
        payer = signer,
        space = 8 + Credit::INIT_SPACE,
        seeds = [b"credit".as_ref(), tab.player.as_ref(), &seed_commit],
        bump
    )]
    pub credit: Box<Account<'info, Credit>>,
    #[account(mut)]
    pub signer: Signer<'info>,
    /// CHECK: validated against cabinet.operator in the handler
    #[account(mut)]
    pub operator: UncheckedAccount<'info>,
    /// CHECK: validated against arcade.treasury in the handler
    #[account(mut)]
    pub treasury: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
    #[account(seeds = [b"stakes".as_ref(), &[cabinet.id]], bump = stakes.bump)]
    pub stakes: Account<'info, Stakes>,
    /// CHECK: the SlotHashes sysvar, address-checked
    #[account(address = anchor_lang::solana_program::sysvar::slot_hashes::ID)]
    pub slot_hashes: UncheckedAccount<'info>,
}

#[derive(Accounts)]
pub struct CloseTab<'info> {
    #[account(
        mut,
        close = player,
        seeds = [b"tab".as_ref(), player.key().as_ref()],
        bump = tab.bump,
        constraint = tab.player == player.key() @ QuartersError::WrongPlayer
    )]
    pub tab: Account<'info, Tab>,
    #[account(mut)]
    pub player: Signer<'info>,
}

// ---------- events / errors ----------

#[event]
pub struct CoinInserted {
    pub player: Pubkey,
    pub cabinet_id: u8,
    pub credit_index: u64,
    pub seed_commit: [u8; 32],
    pub day: u32,
}

#[event]
pub struct ScoreSubmitted {
    pub player: Pubkey,
    pub cabinet_id: u8,
    pub credit_index: u64,
    pub score: u32,
    pub replay_hash: [u8; 32],
    pub day: u32,
}

#[event]
pub struct BountyClaimed {
    pub player: Pubkey,
    pub cabinet_id: u8,
    pub score: u32,
    pub paid: u64,
    pub replay_hash: [u8; 32],
}

#[event]
pub struct PotSettledEvent {
    pub cabinet_id: u8,
    pub day: u32,
    pub pool: u64,
    pub winners: u8,
}

#[error_code]
pub enum QuartersError {
    #[msg("split basis points exceed 100%")]
    BadSplits,
    #[msg("operator account does not match cabinet operator")]
    WrongOperator,
    #[msg("treasury account does not match arcade treasury")]
    WrongTreasury,
    #[msg("signer is not the arcade verifier")]
    NotVerifier,
    #[msg("credit already consumed")]
    CreditConsumed,
    #[msg("pot already settled")]
    PotSettled,
    #[msg("pot day mismatch")]
    WrongDay,
    #[msg("cabinet mismatch")]
    WrongCabinet,
    #[msg("score does not beat the standing record")]
    RecordStands,
    #[msg("player account does not match credit")]
    WrongPlayer,
    #[msg("day not over yet")]
    DayNotOver,
    #[msg("credit's submit window has passed")]
    SubmitWindow,
    #[msg("winner accounts do not match leaderboard")]
    WrongWinnerAccounts,
    #[msg("signer is neither the tab's session key nor its owner")]
    NotSession,
    #[msg("tab balance cannot cover a quarter")]
    TabEmpty,
}

#[derive(Accounts)]
#[instruction(cabinet_id: u8)]
pub struct SetStakes<'info> {
    #[account(seeds = [b"arcade".as_ref()], bump = arcade.bump, has_one = authority)]
    pub arcade: Account<'info, Arcade>,
    #[account(
        init_if_needed,
        payer = authority,
        space = 8 + Stakes::INIT_SPACE,
        seeds = [b"stakes".as_ref(), &[cabinet_id]],
        bump
    )]
    pub stakes: Account<'info, Stakes>,
    #[account(mut)]
    pub authority: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[account]
#[derive(InitSpace)]
pub struct Stakes {
    pub cabinet_id: u8,
    pub price: u64,
    pub bump: u8,
}

#[derive(Accounts)]
#[instruction(day: u32)]
pub struct OpenPot<'info> {
    #[account(seeds = [b"arcade"], bump = arcade.bump)]
    pub arcade: Account<'info, Arcade>,
    #[account(seeds = [b"cabinet".as_ref(), &[cabinet.id]], bump = cabinet.bump)]
    pub cabinet: Account<'info, Cabinet>,
    #[account(
        init_if_needed,
        payer = payer,
        space = 8 + DailyPot::INIT_SPACE,
        seeds = [b"pot".as_ref(), &[cabinet.id], &day.to_le_bytes()],
        bump
    )]
    pub pot: Account<'info, DailyPot>,
    #[account(mut)]
    pub payer: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct CloseExpiredCredit<'info> {
    #[account(
        mut,
        close = rent_payer,
        seeds = [b"credit".as_ref(), credit.player.as_ref(), &credit.seed_commit],
        bump = credit.bump
    )]
    pub credit: Account<'info, Credit>,
    /// CHECK: rent refund destination; must be whoever fronted the rent
    #[account(mut, constraint = rent_payer.key() == credit.rent_payer @ QuartersError::WrongPlayer)]
    pub rent_payer: UncheckedAccount<'info>,
}
