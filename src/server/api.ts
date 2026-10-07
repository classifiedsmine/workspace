/**
 * Production Authoritative REST API Router for WorkSphere Freelance Marketplace.
 * Connected to Persistent SQL Database, Domain Services, Double-Entry Ledger,
 * and Granular RBAC Permission Middleware.
 */

import { Router, Request, Response } from 'express';
import { dbEngine } from './db/database.ts';
import { requireAdminPermission, authenticateUser, AuthenticatedRequest } from './middleware/auth.ts';
import { WalletService } from './services/WalletService.ts';
import { LedgerService } from './services/LedgerService.ts';
import { EscrowService } from './services/EscrowService.ts';
import { WithdrawalService } from './services/WithdrawalService.ts';
import { PaymentService } from './services/PaymentService.ts';
import { DisputeService } from './services/DisputeService.ts';
import { ReconciliationService } from './services/ReconciliationService.ts';
import { BackupManagerService } from './services/BackupManagerService.ts';
import { FileStorageService } from './services/FileStorageService.ts';

const router = Router();

// ----------------- AUTH & UNIFIED IDENTITY -----------------
router.get('/auth/users', (req: Request, res: Response) => {
  const users = dbEngine.query('SELECT * FROM users WHERE deleted_at IS NULL ORDER BY created_at DESC');
  res.json({ users });
});

router.get('/auth/user/:id', async (req: Request, res: Response) => {
  const user = dbEngine.queryOne('SELECT * FROM users WHERE id = ? AND deleted_at IS NULL', [req.params.id]);
  if (!user) return res.status(404).json({ error: 'User not found' });
  const wallet = await WalletService.getOrCreateWallet(user.id);
  res.json({ user, wallet });
});

router.post('/auth/switch-mode', (req: Request, res: Response) => {
  const { userId, mode } = req.body;
  const user = dbEngine.queryOne('SELECT * FROM users WHERE id = ?', [userId]);
  if (!user) return res.status(404).json({ error: 'User not found' });
  if (!['CLIENT', 'FREELANCER', 'ADMIN'].includes(mode)) {
    return res.status(400).json({ error: 'Invalid mode' });
  }
  const now = new Date().toISOString();
  dbEngine.exec('UPDATE users SET active_mode = ?, updated_at = ? WHERE id = ?', [mode, now, userId]);
  res.json({ success: true, mode });
});

router.post('/auth/verify-kyc', (req: Request, res: Response) => {
  const { userId, status } = req.body;
  const user = dbEngine.queryOne('SELECT * FROM users WHERE id = ?', [userId]);
  if (!user) return res.status(404).json({ error: 'User not found' });
  const kycStatus = status || 'VERIFIED';
  const now = new Date().toISOString();
  dbEngine.exec('UPDATE users SET verification_status = ?, updated_at = ? WHERE id = ?', [kycStatus, now, userId]);
  res.json({ success: true, verificationStatus: kycStatus });
});

// ----------------- MARKETPLACE DISCOVERY -----------------
router.get('/marketplace/categories', (req: Request, res: Response) => {
  const categories = dbEngine.query('SELECT * FROM categories WHERE active = 1');
  const subcategories = dbEngine.query('SELECT * FROM subcategories WHERE active = 1');

  const result = categories.map((c: any) => ({
    ...c,
    subcategories: subcategories.filter((s: any) => s.category_id === c.id),
  }));

  res.json({ categories: result });
});

router.get('/marketplace/projects', (req: Request, res: Response) => {
  const { category, search, experience, pricingModel } = req.query;
  let projects = dbEngine.query('SELECT * FROM projects WHERE deleted_at IS NULL ORDER BY created_at DESC');

  if (category && category !== 'all') {
    const q = String(category).toLowerCase();
    projects = projects.filter((p: any) => (p.category || '').toLowerCase().includes(q));
  }
  if (search) {
    const q = String(search).toLowerCase();
    projects = projects.filter(
      (p: any) => (p.title || '').toLowerCase().includes(q) || (p.description || '').toLowerCase().includes(q)
    );
  }

  res.json({ projects });
});

router.get('/marketplace/projects/:slugOrId', (req: Request, res: Response) => {
  const p = dbEngine.queryOne('SELECT * FROM projects WHERE (slug = ? OR id = ?) AND deleted_at IS NULL', [
    req.params.slugOrId,
    req.params.slugOrId,
  ]);
  if (!p) return res.status(404).json({ error: 'Project not found' });
  const proposals = dbEngine.query('SELECT * FROM proposals WHERE project_id = ?', [p.id]);
  res.json({ project: p, proposals });
});

router.post('/marketplace/projects', (req: Request, res: Response) => {
  const { clientId, title, description, category, subcategory, skills, budget, pricingModel, experienceLevel, duration } =
    req.body;
  const client = dbEngine.queryOne('SELECT * FROM users WHERE id = ?', [clientId]);
  if (!client) return res.status(400).json({ error: 'Invalid client' });

  const id = `prj-${Date.now()}`;
  const slug =
    title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/(^-|-$)/g, '') +
    '-' +
    Math.floor(Math.random() * 1000);
  const now = new Date().toISOString();

  dbEngine.exec(
    `INSERT INTO projects (id, slug, client_id, title, description, category, subcategory, budget_cents, currency, pricing_model, experience_level, duration, proposals_count, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'USD', ?, ?, ?, 0, 'PUBLISHED', ?, ?)`,
    [
      id,
      slug,
      clientId,
      title,
      description,
      category,
      subcategory || category,
      Math.round(Number(budget) * 100),
      pricingModel || 'FIXED',
      experienceLevel || 'INTERMEDIATE',
      duration || '1 to 3 months',
      now,
      now,
    ]
  );

  const newProject = dbEngine.queryOne('SELECT * FROM projects WHERE id = ?', [id]);
  res.json({ success: true, project: newProject });
});

router.get('/marketplace/offers', (req: Request, res: Response) => {
  const offers = dbEngine.query('SELECT * FROM offers WHERE deleted_at IS NULL ORDER BY created_at DESC');
  res.json({ offers });
});

router.get('/marketplace/offers/:slugOrId', (req: Request, res: Response) => {
  const offer = dbEngine.queryOne('SELECT * FROM offers WHERE (slug = ? OR id = ?) AND deleted_at IS NULL', [
    req.params.slugOrId,
    req.params.slugOrId,
  ]);
  if (!offer) return res.status(404).json({ error: 'Offer not found' });
  res.json({ offer });
});

// ----------------- FINANCIAL & ESCROW ENDPOINTS -----------------
router.post('/payments/deposit', async (req: Request, res: Response) => {
  try {
    const { userId, amount, provider } = req.body;
    const amountCents = Math.round(Number(amount) * 100);
    const eventId = `dep_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`;

    const result = await PaymentService.handleVerifiedWebhook({
      provider: provider || 'RAZORPAY',
      eventId,
      eventType: 'manual.deposit',
      userId,
      amountCents,
      currency: 'USD',
      rawPayload: { manualDeposit: true },
    });

    res.json(result);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/withdrawals/request', async (req: Request, res: Response) => {
  try {
    const { userId, amount, paymentMethod, accountDetails, idempotencyKey } = req.body;
    const amountCents = Math.round(Number(amount) * 100);

    const result = await WithdrawalService.requestWithdrawal({
      idempotencyKey: idempotencyKey || `wdr_key_${Date.now()}`,
      userId,
      amountCents,
      paymentMethod: paymentMethod || 'Bank Wire',
      accountDetails: accountDetails || 'Primary Bank Account',
    });

    res.json(result);
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

router.post('/contracts/:contractId/milestones/:milestoneId/release', async (req: Request, res: Response) => {
  try {
    const { contractId, milestoneId } = req.params;
    const { userId } = req.body;

    const result = await EscrowService.releaseMilestoneEscrow(contractId, milestoneId, userId || 'usr-1');
    res.json(result);
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

// ----------------- ADMIN RBAC ENDPOINTS -----------------
router.get('/admin/kpis', requireAdminPermission('users.view'), (req: Request, res: Response) => {
  const usersCount = dbEngine.queryOne<any>('SELECT COUNT(*) as cnt FROM users WHERE deleted_at IS NULL')!.cnt;
  const projectsCount = dbEngine.queryOne<any>('SELECT COUNT(*) as cnt FROM projects WHERE deleted_at IS NULL')!.cnt;
  const contractsCount = dbEngine.queryOne<any>('SELECT COUNT(*) as cnt FROM contracts')!.cnt;
  const disputesCount = dbEngine.queryOne<any>('SELECT COUNT(*) as cnt FROM disputes')!.cnt;

  res.json({
    kpis: {
      totalUsers: usersCount,
      totalProjects: projectsCount,
      totalContracts: contractsCount,
      activeDisputes: disputesCount,
      systemHealth: 'OPERATIONAL',
    },
  });
});

router.get('/admin/audit-logs', requireAdminPermission('audit_logs.view'), (req: Request, res: Response) => {
  const logs = dbEngine.query('SELECT * FROM admin_audit_logs ORDER BY created_at DESC LIMIT 100');
  res.json({ logs });
});

router.get('/admin/reconciliation', requireAdminPermission('payments.view'), async (req: Request, res: Response) => {
  const report = await ReconciliationService.runReconciliationAudit();
  res.json(report);
});

router.get('/admin/backups', requireAdminPermission('system.maintenance'), (req: Request, res: Response) => {
  const backups = BackupManagerService.listBackups();
  res.json({ backups });
});

router.post('/admin/backups/create', requireAdminPermission('system.maintenance'), async (req: Request, res: Response) => {
  const backup = await BackupManagerService.createBackup();
  res.json({ success: true, backup });
});

export default router;
