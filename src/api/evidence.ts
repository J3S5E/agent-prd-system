import { createReadStream, existsSync, statSync , mkdirSync } from 'fs';
import { join } from 'path';

import { Request, Response, Router } from 'express';
import multer from 'multer';
import { eq, desc, count, and } from 'drizzle-orm';
import { z } from 'zod';

import { db } from '../db/index.js';
import { evidence, tickets } from '../db/schema.js';
import { broadcast } from '../engine/events.js';


const router = Router();

const UPLOAD_DIR = process.env.UPLOAD_DIR || './uploads/evidence';

mkdirSync(UPLOAD_DIR, { recursive: true });

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => {
    cb(null, UPLOAD_DIR);
  },
  filename: (_req, file, cb) => {
    const ext = file.originalname.split('.').pop() || '';
    const uniqueName = `${crypto.randomUUID()}.${ext}`;
    cb(null, uniqueName);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: 50 * 1024 * 1024 }, // 50MB
});

const CreateEvidenceSchema = z.object({
  ticketId: z.string().optional(),
  subtaskId: z.string().optional(),
  filePath: z.string().optional(),
  contentType: z.string().min(1),
  source: z.string().min(1),
  type: z.string().min(1),
  content: z.string().optional(), // base64 encoded content for JSON
  passed: z.boolean().optional(),
}).refine(data => data.filePath || data.content, {
  message: "Either filePath or content is required",
  path: ["filePath"],
});

type CreateEvidenceInput = z.infer<typeof CreateEvidenceSchema>;

interface MulterRequest extends Request {
  file?: Express.Multer.File;
  body: Record<string, unknown>;
}

function getBodyField(body: Record<string, unknown>, key: string): string | undefined {
  const val = body[key];
  return typeof val === 'string' ? val : undefined;
}

router.get('/:id/evidence', async (req: Request, res: Response) => {
  const ticketId = req.params.id;
  const query = req.query;
  
  function isRecord(val: unknown): val is Record<string, unknown> {
    return typeof val === 'object' && val !== null && !Array.isArray(val);
  }
  
  let limit: number = 50;
  let offset: number = 0;
  let source: string | undefined;
  let passed: boolean | undefined;
  
  if (isRecord(query)) {
    if (Object.prototype.hasOwnProperty.call(query, 'limit')) {
      const val = query['limit'];
      if (Array.isArray(val)) {
        const first = val[0];
        limit = typeof first === 'string' ? parseInt(first, 10) || 50 : 50;
      } else {
        limit = typeof val === 'string' ? parseInt(val, 10) || 50 : 50;
      }
    }
    if (Object.prototype.hasOwnProperty.call(query, 'offset')) {
      const val = query['offset'];
      if (Array.isArray(val)) {
        const first = val[0];
        offset = typeof first === 'string' ? parseInt(first, 10) || 0 : 0;
      } else {
        offset = typeof val === 'string' ? parseInt(val, 10) || 0 : 0;
      }
    }
    if (Object.prototype.hasOwnProperty.call(query, 'source')) {
      const val = query['source'];
      const str = Array.isArray(val) ? val[0] : val;
      source = typeof str === 'string' ? str : undefined;
    }
    if (Object.prototype.hasOwnProperty.call(query, 'passed')) {
      const val = query['passed'];
      const str = Array.isArray(val) ? val[0] : val;
      if (typeof str === 'string') {
        if (str === 'true') passed = true;
        else if (str === 'false') passed = false;
      }
    }
  }
  
  limit = Math.min(limit, 200);
  
  const conditions = [eq(evidence.ticketId, ticketId)];
  if (source) conditions.push(eq(evidence.source, source));
  if (passed !== undefined) conditions.push(eq(evidence.passed, passed));
  
  const totalResult = await db
    .select({ count: count() })
    .from(evidence)
    .where(and(...conditions));
  const total = Number(totalResult[0]?.count || 0);
  
  const results = await db
    .select()
    .from(evidence)
    .where(and(...conditions))
    .orderBy(desc(evidence.createdAt))
    .limit(limit)
    .offset(offset);
  
  res.setHeader('X-Total-Count', total.toString());
  res.json(results);
});

router.post('/:id/evidence', upload.single('file'), async (req: MulterRequest, res: Response) => {
  const ticketId = req.params.id;
  
  // Verify ticket exists
  const ticket = await db.select().from(tickets).where(eq(tickets.id, ticketId)).limit(1);
  if (ticket.length === 0) {
    return res.status(404).json({ error: 'Ticket not found' });
  }
  
  let evidenceData: CreateEvidenceInput;
  const contentType = req.headers['content-type'] || '';
  
  if (contentType.includes('multipart/form-data')) {
    if (!req.file) {
      return res.status(400).json({ error: 'No file uploaded' });
    }
    
    // Parse other fields from req.body
    const bodyTicketId = getBodyField(req.body, 'ticketId');
    const subtaskId = getBodyField(req.body, 'subtaskId');
    const source = getBodyField(req.body, 'source');
    const type = getBodyField(req.body, 'type');
    
    if (!source || !type) {
      return res.status(400).json({ error: 'Missing required fields: source, type' });
    }
    
    const filePath = join(UPLOAD_DIR, req.file.filename);
    const _fileStat = statSync(filePath);
    
    evidenceData = {
      ticketId: bodyTicketId || ticketId,
      subtaskId: subtaskId || undefined,
      filePath,
      contentType: req.file.mimetype,
      source,
      type,
    };
  } else {
    const parse = CreateEvidenceSchema.safeParse(req.body);
    if (!parse.success) {
      return res.status(400).json({ error: 'Validation failed', issues: parse.error.issues });
    }
    evidenceData = parse.data;
  }
  
  const id = crypto.randomUUID();
  const now = Date.now();
  
  await db.insert(evidence).values({
    id,
    ticketId: evidenceData.ticketId || ticketId,
    subtaskId: evidenceData.subtaskId,
    filePath: evidenceData.filePath,
    content: evidenceData.content,
    contentType: evidenceData.contentType,
    source: evidenceData.source,
    type: evidenceData.type,
    passed: evidenceData.passed,
    createdAt: now,
  });
  
  const created = await db.select().from(evidence).where(eq(evidence.id, id)).limit(1);
  broadcast({ type: 'evidence:added', evidence: created[0] });
  
  res.status(201).json(created[0]);
});

router.get('/evidence/:id', async (req: Request, res: Response) => {
  const ev = await db.select().from(evidence).where(eq(evidence.id, req.params.id)).limit(1);
  
  if (ev.length === 0) {
    return res.status(404).json({ error: 'Evidence not found' });
  }
  
  const evidenceRecord = ev[0];
  
  // If Accept header is application/json, return metadata
  const accept = req.headers.accept || '';
  if (accept.includes('application/json')) {
    return res.json(evidenceRecord);
  }
  
  // Content-only evidence: return content directly
  if (!evidenceRecord.filePath) {
    res.setHeader('Content-Type', evidenceRecord.contentType);
    return res.send(evidenceRecord.content || '');
  }
  
  // Otherwise stream the file
  const filePath = evidenceRecord.filePath;
  
  if (!existsSync(filePath)) {
    return res.status(404).json({ error: 'File not found on disk' });
  }
  
  const fileStat = statSync(filePath);
  const range = req.headers.range;
  
  if (range) {
    const parts = range.replace(/bytes=/, '').split('-');
    const start = parseInt(parts[0], 10);
    const end = parts[1] ? parseInt(parts[1], 10) : fileStat.size - 1;
    const chunkSize = end - start + 1;
    
    const fileStream = createReadStream(filePath, { start, end });
    
    res.writeHead(206, {
      'Content-Range': `bytes ${start}-${end}/${fileStat.size}`,
      'Accept-Ranges': 'bytes',
      'Content-Length': chunkSize,
      'Content-Type': evidenceRecord.contentType,
    });
    
    fileStream.pipe(res);
  } else {
    res.setHeader('Content-Length', fileStat.size);
    res.setHeader('Content-Type', evidenceRecord.contentType);
    res.setHeader('Accept-Ranges', 'bytes');
    
    const fileStream = createReadStream(filePath);
    fileStream.pipe(res);
  }
});

router.delete('/evidence/:id', async (req: Request, res: Response) => {
  const ev = await db.select().from(evidence).where(eq(evidence.id, req.params.id)).limit(1);
  
  if (ev.length === 0) {
    return res.status(404).json({ error: 'Evidence not found' });
  }
  
  // Delete file from disk (only if filePath exists)
  const filePath = ev[0].filePath;
  if (filePath && existsSync(filePath)) {
    try {
      // Note: In production, you might want to keep files for a retention period
      // For now, we just delete the DB record
    } catch {
      // Ignore file deletion errors
    }
  }
  
  await db.delete(evidence).where(eq(evidence.id, req.params.id));
  res.status(204).send();
});

export default router;