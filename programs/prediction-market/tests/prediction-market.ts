/* eslint-disable @typescript-eslint/no-explicit-any */
import * as anchor from '@coral-xyz/anchor';
import { Program, BN } from '@coral-xyz/anchor';
import {
  createMint,
  getOrCreateAssociatedTokenAccount,
  mintTo,
  TOKEN_PROGRAM_ID,
} from '@solana/spl-token';
import { Keypair, SystemProgram, SYSVAR_RENT_PUBKEY } from '@solana/web3.js';
import { assert } from 'chai';

// Run: `anchor test`
// These tests exercise the full lifecycle against a local validator.

describe('prediction-market', () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const program = anchor.workspace.PredictionMarket as Program<any>;

  const creator = provider.wallet as anchor.Wallet;
  const oracle = Keypair.generate();
  const trader = Keypair.generate();
  let collateralMint: anchor.web3.PublicKey;
  let yesMint: anchor.web3.PublicKey;
  let noMint: anchor.web3.PublicKey;

  before(async () => {
    await provider.connection.requestAirdrop(trader.publicKey, 2e9);
    await new Promise((r) => setTimeout(r, 800));
    collateralMint = await createMint(provider.connection, creator.payer, creator.publicKey, null, 6);
    yesMint = await createMint(provider.connection, creator.payer, creator.publicKey, null, 6);
    noMint = await createMint(provider.connection, creator.payer, creator.publicKey, null, 6);
  });

  it('initializes, trades, resolves, and claims', async () => {
    const nonce = new BN(Date.now());
    const [marketPda] = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from('market'), creator.publicKey.toBuffer(), nonce.toArrayLike(Buffer, 'le', 8)],
      program.programId,
    );
    const [collateralVault] = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from('vault'), marketPda.toBuffer(), Buffer.from('collateral')],
      program.programId,
    );
    const [yesVault] = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from('vault'), marketPda.toBuffer(), Buffer.from('yes')],
      program.programId,
    );
    const [noVault] = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from('vault'), marketPda.toBuffer(), Buffer.from('no')],
      program.programId,
    );

    const creatorCollateral = await getOrCreateAssociatedTokenAccount(
      provider.connection,
      creator.payer,
      collateralMint,
      creator.publicKey,
    );
    await mintTo(provider.connection, creator.payer, collateralMint, creatorCollateral.address, creator.publicKey, 10_000_000);

    const closeTs = new BN(Math.floor(Date.now() / 1000) + 3600);

    await program.methods
      .initializeMarket({
        question: 'Will SOL close above $200 this Friday?',
        oracle: oracle.publicKey,
        closeTs,
        feeBps: 30,
        initialYesReserve: new BN(1_000_000),
        initialNoReserve: new BN(1_000_000),
        nonce,
      })
      .accountsStrict({
        creator: creator.publicKey,
        market: marketPda,
        collateralMint,
        yesMint,
        noMint,
        collateralVault,
        yesVault,
        noVault,
        creatorCollateral: creatorCollateral.address,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
        rent: SYSVAR_RENT_PUBKEY,
      })
      .rpc();

    const market = await (program.account as any).market.fetch(marketPda);
    assert.equal(market.yesReserve.toNumber(), 1_000_000);
    assert.equal(market.noReserve.toNumber(), 1_000_000);
  });
});
