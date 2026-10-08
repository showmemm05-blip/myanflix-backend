import { Module } from '@nestjs/common';
import { MinioService } from '../common/storage/minio.service';
import { RolesModule } from '../roles/roles.module';
import { HomeController } from './home.controller';
import { HomePromosService } from './home-promos.service';
import { HomeShowcaseService } from './home-showcase.service';

/**
 * The home showcase: public GET /home/showcase plus the staff "Home promos"
 * routes. MinioService is listed in providers like every module that
 * re-hosts image URLs (see app.module.spec.ts); AuditService is global.
 */
@Module({
  imports: [RolesModule],
  controllers: [HomeController],
  providers: [HomeShowcaseService, HomePromosService, MinioService],
  exports: [HomeShowcaseService],
})
export class HomeModule {}
