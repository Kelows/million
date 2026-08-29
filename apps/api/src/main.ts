import { NestFactory } from '@nestjs/core';
import type { Request, Response, NextFunction } from 'express';
import { AppModule } from './app.module';

// The Cloudflare tunnel exists to deliver ONE thing: Helius webhooks. Tunnel
// traffic (cf-ray header = proxied through Cloudflare) gets exactly that path
// and nothing else — the app itself stays local-only.
const TUNNEL_ALLOWED = '/api/live/webhook';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  app.setGlobalPrefix('api');
  app.enableCors({ origin: true });
  app.use((req: Request, res: Response, next: NextFunction) => {
    if (req.headers['cf-ray'] && req.path !== TUNNEL_ALLOWED) return res.status(404).end();
    next();
  });
  await app.listen(process.env.PORT ?? 3001);
}
bootstrap();
















