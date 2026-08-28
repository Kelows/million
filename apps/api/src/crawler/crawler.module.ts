import { Module } from '@nestjs/common';
import { ConsensusService } from '../analysis/consensus.service';
import { OwnersService } from '../analysis/owners.service';
import { DexScreenerService } from '../analysis/dexscreener.service';
import { HeliusService } from '../analysis/helius.service';
import { TokenMetaService } from '../analysis/token-meta.service';
import { RugcheckService } from '../screener/rugcheck.service';
import { JupiterService } from '../analysis/jupiter.service';
import { TokenCheckService } from '../screener/token-check.service';
import { DiscoveryService } from '../discovery/discovery.service';
import { GemsService } from '../gems/gems.service';
import { WalletsService } from '../wallets/wallets.service';
import { PrismaService } from '../prisma.service';
import { CrawlerController } from './crawler.controller';
import { CrawlerService } from './crawler.service';

@Module({
  controllers: [CrawlerController],
  providers: [
    CrawlerService,
    GemsService,
    DiscoveryService,
    WalletsService,
    ConsensusService,
    OwnersService,
    TokenCheckService,
    TokenMetaService,
    DexScreenerService,
    RugcheckService,
    JupiterService,
    HeliusService,
    PrismaService,
  ],
})
export class CrawlerModule {}
