import { forwardRef, Module } from '@nestjs/common';
import { RolesModule } from '../roles/roles.module';
import { MoviesModule } from '../movies/movies.module';
import { VideosModule } from '../videos/videos.module';
import { UsersController } from './users.controller';
import { UsersService } from './users.service';
import { UserRelationshipsService } from './user-relationships.service';

@Module({
  imports: [
    RolesModule,
    MoviesModule,
    VideosModule,
    // Deliberately a deferred require, not a top-of-file import: this edge
    // closes a module require cycle (users -> wallet -> realtime -> users,
    // since RealtimeModule imports UsersModule for the gateway's
    // UsersService). AuthModule loads this file first at boot, so an eager
    // require here would make realtime.module.ts see a partially-initialized
    // users.module.ts and register `undefined` in its imports array. By the
    // time Nest resolves this forwardRef, every module file has finished
    // loading and the require hits the cache.
    forwardRef(() => {
      const { WalletModule } =
        // eslint-disable-next-line @typescript-eslint/no-require-imports -- the deferral IS the point (see above)
        require('../wallet/wallet.module') as typeof import('../wallet/wallet.module');
      return WalletModule;
    }),
  ],
  controllers: [UsersController],
  providers: [UsersService, UserRelationshipsService],
  exports: [UsersService],
})
export class UsersModule {}
