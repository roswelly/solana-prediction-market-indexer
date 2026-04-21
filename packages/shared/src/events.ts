/**
 * Canonical on-chain event shapes produced by the prediction_market program.
 *
 * These mirror the `#[event]` structs in `programs/prediction-market/src/lib.rs`.
 * The indexer's Anchor-event parser produces these types; downstream consumers
 * (API, bot, dashboards) depend only on this module.
 */

export interface MarketInitializedEvent {
  kind: 'MarketInitialized';
  market: string;
  creator: string;
  oracle: string;
  collateralMint: string;
  yesReserve: bigint;
  noReserve: bigint;
  closeTs: number;
  feeBps: number;
  question: string;
}

export interface TradeExecutedEvent {
  kind: 'TradeExecuted';
  market: string;
  trader: string;
  side: 'BUY' | 'SELL';
  outcome: 'YES' | 'NO';
  amountIn: bigint;
  shares: bigint;
  fee: bigint;
  yesReserveAfter: bigint;
  noReserveAfter: bigint;
  ts: number;
}

export interface MarketResolvedEvent {
  kind: 'MarketResolved';
  market: string;
  winningOutcome: 'YES' | 'NO' | 'INVALID';
  resolutionTs: number;
}

export interface ClaimedEvent {
  kind: 'Claimed';
  market: string;
  trader: string;
  payout: bigint;
  ts: number;
}

export type ProgramEvent =
  | MarketInitializedEvent
  | TradeExecutedEvent
  | MarketResolvedEvent
  | ClaimedEvent;

export interface IndexedEvent {
  signature: string;
  slot: number;
  blockTime: number;
  event: ProgramEvent;
}
