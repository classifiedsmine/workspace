/**
 * Production Wallet Service.
 * Manages user balance updates with mutex locks, integer cents math,
 * and overdraft prevention.
 */

import { dbEngine } from '../db/database.ts';

export interface WalletRecord {
  id: string;
  userId: string;
  currency: string;
  availableCents: number;
  escrowCents: number;
  pendingWithdrawalCents: number;
  createdAt: string;
  updatedAt: string;
}

export class WalletService {
  /**
   * Retrieve or create wallet for user.
   */
  public static async getOrCreateWallet(userId: string): Promise<WalletRecord> {
    const existing = dbEngine.queryOne<any>('SELECT * FROM wallets WHERE user_id = ?', [userId]);

    if (existing) {
      return {
        id: existing.id,
        userId: existing.user_id,
        currency: existing.currency || 'USD',
        availableCents: existing.available_cents,
        escrowCents: existing.escrow_cents,
        pendingWithdrawalCents: existing.pending_withdrawal_cents,
        createdAt: existing.created_at,
        updatedAt: existing.updated_at,
      };
    }

    const now = new Date().toISOString();
    const walletId = `wal_${userId}`;

    dbEngine.exec(
      `INSERT INTO wallets (id, user_id, currency, available_cents, escrow_cents, pending_withdrawal_cents, created_at, updated_at) VALUES (?, ?, ?, 0, 0, 0, ?, ?)`,
      [walletId, userId, 'USD', now, now]
    );

    return {
      id: walletId,
      userId,
      currency: 'USD',
      availableCents: 0,
      escrowCents: 0,
      pendingWithdrawalCents: 0,
      createdAt: now,
      updatedAt: now,
    };
  }

  /**
   * Credit available balance in integer cents.
   */
  public static async creditAvailable(userId: string, amountCents: number): Promise<WalletRecord> {
    const releaseLock = await dbEngine.acquireLock(`wallet_${userId}`);
    try {
      const wallet = await this.getOrCreateWallet(userId);
      const newAvailable = wallet.availableCents + amountCents;
      const now = new Date().toISOString();

      dbEngine.exec('UPDATE wallets SET available_cents = ?, updated_at = ? WHERE user_id = ?', [
        newAvailable,
        now,
        userId,
      ]);

      return { ...wallet, availableCents: newAvailable, updatedAt: now };
    } finally {
      releaseLock();
    }
  }

  /**
   * Debit available balance with strict overdraft check.
   */
  public static async debitAvailable(userId: string, amountCents: number): Promise<WalletRecord> {
    const releaseLock = await dbEngine.acquireLock(`wallet_${userId}`);
    try {
      const wallet = await this.getOrCreateWallet(userId);
      if (wallet.availableCents < amountCents) {
        throw new Error(
          `Insufficient Funds: Required $${(amountCents / 100).toFixed(2)}, Available $${(
            wallet.availableCents / 100
          ).toFixed(2)}`
        );
      }

      const newAvailable = wallet.availableCents - amountCents;
      const now = new Date().toISOString();

      dbEngine.exec('UPDATE wallets SET available_cents = ?, updated_at = ? WHERE user_id = ?', [
        newAvailable,
        now,
        userId,
      ]);

      return { ...wallet, availableCents: newAvailable, updatedAt: now };
    } finally {
      releaseLock();
    }
  }

  /**
   * Move available funds into escrow balance.
   */
  public static async moveAvailableToEscrow(userId: string, amountCents: number): Promise<WalletRecord> {
    const releaseLock = await dbEngine.acquireLock(`wallet_${userId}`);
    try {
      const wallet = await this.getOrCreateWallet(userId);
      if (wallet.availableCents < amountCents) {
        throw new Error('Insufficient funds to fund escrow hold.');
      }

      const newAvailable = wallet.availableCents - amountCents;
      const newEscrow = wallet.escrowCents + amountCents;
      const now = new Date().toISOString();

      dbEngine.exec(
        'UPDATE wallets SET available_cents = ?, escrow_cents = ?, updated_at = ? WHERE user_id = ?',
        [newAvailable, newEscrow, now, userId]
      );

      return { ...wallet, availableCents: newAvailable, escrowCents: newEscrow, updatedAt: now };
    } finally {
      releaseLock();
    }
  }

  /**
   * Release escrow balance to recipient available balance.
   */
  public static async releaseEscrowToUser(
    senderUserId: string,
    recipientUserId: string,
    amountCents: number
  ): Promise<{ senderWallet: WalletRecord; recipientWallet: WalletRecord }> {
    const lockSender = await dbEngine.acquireLock(`wallet_${senderUserId}`);
    const lockRecipient = await dbEngine.acquireLock(`wallet_${recipientUserId}`);

    try {
      const senderWallet = await this.getOrCreateWallet(senderUserId);
      const recipientWallet = await this.getOrCreateWallet(recipientUserId);

      if (senderWallet.escrowCents < amountCents) {
        throw new Error('Escrow release error: Requested release amount exceeds held escrow balance.');
      }

      const newSenderEscrow = senderWallet.escrowCents - amountCents;
      const newRecipientAvailable = recipientWallet.availableCents + amountCents;
      const now = new Date().toISOString();

      dbEngine.exec('UPDATE wallets SET escrow_cents = ?, updated_at = ? WHERE user_id = ?', [
        newSenderEscrow,
        now,
        senderUserId,
      ]);

      dbEngine.exec('UPDATE wallets SET available_cents = ?, updated_at = ? WHERE user_id = ?', [
        newRecipientAvailable,
        now,
        recipientUserId,
      ]);

      return {
        senderWallet: { ...senderWallet, escrowCents: newSenderEscrow, updatedAt: now },
        recipientWallet: { ...recipientWallet, availableCents: newRecipientAvailable, updatedAt: now },
      };
    } finally {
      lockRecipient();
      lockSender();
    }
  }
}
