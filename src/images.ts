import { createHash, randomUUID } from 'node:crypto';
import { link, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import sharp from 'sharp';
import type { Api } from './lib/api.ts';
import { ApiError, notFound } from './lib/api.ts';
import { env } from './lib/config.ts';

const invalidImage = () => new ApiError(400, 'INVALID_IMAGE', 'Elige una imagen JPEG, PNG o WebP de hasta 5 MB.');

export function mountImages(api: Api) {
  api.route<{ content: string }>('uploadEventImage', { role: 'organizador', bodyLimit: '8mb' }, async (req, res) => {
    const { content } = req.body;
    if (content.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(content)) throw invalidImage();
    const input = Buffer.from(content, 'base64');
    if (!input.length || input.length > 5 * 1024 * 1024) throw invalidImage();
    let encoded: Buffer;
    try {
      const image = sharp(input, { limitInputPixels: 24_000_000, failOn: 'warning' }).timeout({ seconds: 5 });
      const metadata = await image.metadata();
      if (!['jpeg', 'png', 'webp'].includes(metadata.format ?? '') || (metadata.pages ?? 1) !== 1) throw invalidImage();
      encoded = await image.rotate().resize({ width: 1920, height: 1920, fit: 'inside', withoutEnlargement: true })
        .webp({ quality: 88 }).toBuffer();
    } catch { throw invalidImage(); }
    // El mismo contenido produce una única portada y permite reintentar la subida.
    const hash = createHash('sha256').update(encoded).digest('hex').slice(0, 32);
    const imageId = [hash.slice(0, 8), hash.slice(8, 12), '4' + hash.slice(13, 16),
      '8' + hash.slice(17, 20), hash.slice(20)].join('-');
    const destination = join(env('EVENTS_IMAGES_DIR'), imageId + '.webp');
    const temporary = destination + '.' + randomUUID() + '.tmp';
    try {
      await writeFile(temporary, encoded, { flag: 'wx', mode: 0o600 });
      try { await link(temporary, destination); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
    } finally { await rm(temporary, { force: true }); }
    res.status(201).json({ imagePath: '/api/events/images/' + imageId });
  });

  api.route('getEventImage', {}, async (req, res) => {
    let content: Buffer;
    try {
      content = await readFile(join(env('EVENTS_IMAGES_DIR'), req.params.imageId.toLowerCase() + '.webp'));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw notFound();
      throw error;
    }
    res.type('image/webp').set('Cache-Control', 'public, max-age=31536000, immutable').send(content);
  });
}
