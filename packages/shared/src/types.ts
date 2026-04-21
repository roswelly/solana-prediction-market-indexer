export type Outcome = 'YES' | 'NO' | 'INVALID' | 'UNRESOLVED';
export type TradeSide = 'BUY' | 'SELL';
export type MarketState = 'OPEN' | 'RESOLVED';

export interface Market {
  address: string;
  creator: string;
  oracle: string;
  collateralMint: string;
  yesReserve: bigint;
  noReserve: bigint;
  totalVolume: bigint;
  feeBps: number;
  closeTs: number;
  resolutionTs: number | null;
  state: MarketState;
  winningOutcome: Outcome;
  question: string;
  createdSlot: number;
  createdAt: Date;
}

export interface Trade {
  signature: string;
  slot: number;
  market: string;
  trader: string;
  side: TradeSide;
  outcome: Exclude<Outcome, 'UNRESOLVED' | 'INVALID'>;
  amountIn: bigint;
  shares: bigint;
  fee: bigint;
  yesReserveAfter: bigint;
  noReserveAfter: bigint;
  priceYes: number;
  priceNo: number;
  ts: Date;
}

export interface Quote {
  market: string;
  priceYes: number;
  priceNo: number;
  yesReserve: bigint;
  noReserve: bigint;
  ts: Date;
}

export interface OrderIntent {
  market: string;
  side: TradeSide;
  outcome: 'YES' | 'NO';
  amount: bigint;
  limitPrice: number;
  clientId: string;
}
