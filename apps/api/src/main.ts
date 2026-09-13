import { NestFactory } from '@nestjs/core';
import type { Request, Response, NextFunction } from 'express';
import { AppModule } from './app.module';

// The tunnel exists to deliver ONE thing: Helius webhooks. Tunnel traffic gets
// exactly that path and nothing else — the app itself stays local-only, because
// it has no auth and its config endpoint can switch on live trading. Cloudflare
// stamps cf-ray; ngrok and most other tunnels/reverse proxies stamp
// X-Forwarded-*. Vite's dev proxy stamps neither, so the local deck still works.
const TUNNEL_ALLOWED = '/api/live/webhook';
const viaTunnel = (req: Request) =>
  Boolean(req.headers['cf-ray'] || req.headers['x-forwarded-for'] || req.headers['x-forwarded-host']);

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  app.setGlobalPrefix('api');
  app.enableCors({ origin: true });
  app.use((req: Request, res: Response, next: NextFunction) => {
    if (viaTunnel(req) && req.path !== TUNNEL_ALLOWED) return res.status(404).end();
    next();
  });
  await app.listen(process.env.PORT ?? 3001);
}
bootstrap();



































