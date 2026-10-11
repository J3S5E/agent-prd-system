import { Router } from 'express';

import healthRouter from './health.js';
import reposRouter from './repos.js';
import ticketsRouter from './tickets.js';
import evidenceRouter from './evidence.js';
import suggestionsRouter from './suggestions.js';
import deviationsRouter from './deviations.js';
import validationRouter from './validation.js';
import ralphRouter from './ralph.js';
import logsRouter from './logs.js';

const router = Router();

router.use('/health', healthRouter);
router.use('/ready', healthRouter);
router.use('/repos', reposRouter);
// Specific ticket sub-routers MUST come before ticketsRouter (first-match wins)
router.use('/tickets', evidenceRouter);
router.use('/tickets', suggestionsRouter);
router.use('/tickets', deviationsRouter);
router.use('/repos', validationRouter);
router.use('/tickets', validationRouter);
router.use('/tickets', ticketsRouter);
router.use('/ralph', ralphRouter);
router.use('/logs', logsRouter);

export default router;