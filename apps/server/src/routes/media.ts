import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { fileTypeFromBuffer } from 'file-type';
import { imageSize } from 'image-size';
import { parse } from '../lib/validate.js';
import { requireOrganizer } from '../plugins/auth.js';

const ALLOWED = new Map([
  ['image/png', 'png'],
  ['image/jpeg', 'jpg'],
  ['image/webp', 'webp'],
  ['image/gif', 'gif'],
]);

const PatchSchema = z.object({ altText: z.string().max(500) });

export async function mediaRoutes(app: FastifyInstance) {
  app.addHook('preHandler', requireOrganizer);

  app.post('/media', async (req, reply) => {
    const file = await req.file({
      limits: { fileSize: app.config.maxUploadMb * 1024 * 1024, files: 1 },
    });
    if (!file) return reply.code(400).send({ error: 'No file uploaded' });
    let buf: Buffer;
    try {
      buf = await file.toBuffer();
    } catch {
      return reply.code(413).send({ error: 'File too large' });
    }

    const detected = await fileTypeFromBuffer(buf);
    const ext = detected ? ALLOWED.get(detected.mime) : undefined;
    if (!detected || !ext) {
      return reply.code(400).send({ error: 'Unsupported image type (png, jpeg, webp or gif)' });
    }
    if (file.mimetype.startsWith('image/') && file.mimetype !== detected.mime) {
      return reply
        .code(400)
        .send({ error: `Declared type ${file.mimetype} does not match file content` });
    }

    let width: number;
    let height: number;
    try {
      const dims = imageSize(buf);
      width = dims.width;
      height = dims.height;
    } catch {
      return reply.code(400).send({ error: 'Could not read image dimensions' });
    }

    const filename = `${randomUUID()}.${ext}`;
    const dir = path.resolve(app.config.mediaDir);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, filename), buf);

    const asset = await app.prisma.mediaAsset.create({
      data: {
        organizerId: req.organizerId!,
        originalName: file.filename || filename,
        mimeType: detected.mime,
        sizeBytes: buf.length,
        width,
        height,
        storagePath: filename,
      },
    });
    return reply.code(201).send({
      id: asset.id,
      url: `/media/${filename}`,
      width,
      height,
      altText: asset.altText,
    });
  });

  app.get('/media/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const asset = await app.prisma.mediaAsset.findFirst({
      where: { id, organizerId: req.organizerId },
    });
    if (!asset) return reply.code(404).send({ error: 'Media not found' });
    return {
      id: asset.id,
      url: `/media/${asset.storagePath}`,
      width: asset.width,
      height: asset.height,
      altText: asset.altText,
    };
  });

  app.patch('/media/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = parse(PatchSchema, req.body);
    const asset = await app.prisma.mediaAsset.findFirst({
      where: { id, organizerId: req.organizerId },
    });
    if (!asset) return reply.code(404).send({ error: 'Media not found' });
    const updated = await app.prisma.mediaAsset.update({
      where: { id },
      data: { altText: body.altText },
    });
    return {
      id: updated.id,
      url: `/media/${updated.storagePath}`,
      width: updated.width,
      height: updated.height,
      altText: updated.altText,
    };
  });
}
