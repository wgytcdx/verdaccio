import buildDebug from 'debug';
import { Router } from 'express';
import _ from 'lodash';

import { IAuth } from '@verdaccio/auth';
import { logger } from '@verdaccio/logger';
import { $NextFunctionVer, $RequestExtend, $ResponseExtend } from '@verdaccio/middleware';
import { Storage } from '@verdaccio/store';
import { getLocalRegistryTarballUri } from '@verdaccio/tarball';
import { Config, Package, RemoteUser } from '@verdaccio/types';
import { formatAuthor, generateGravatarUrl } from '@verdaccio/utils';

import { AuthorAvatar, sortByName } from '../utils/web-utils';

export { $RequestExtend, $ResponseExtend, $NextFunctionVer }; // Was required by other packages

const getOrder = (order = 'asc') => {
  return order === 'asc';
};

export type PackageExt = Package & { author: AuthorAvatar; dist?: { tarball: string } };

const debug = buildDebug('verdaccio:web:api:package');

function addPackageWebApi(route: Router, storage: Storage, auth: IAuth, config: Config): void {
  const isLoginEnabled = config?.web?.login === true ?? true;
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const anonymousRemoteUser: RemoteUser = {
    name: undefined,
    real_groups: [],
    groups: [],
  };

  debug('initialized package web api');
  const checkAllow = (name: string, remoteUser: RemoteUser): Promise<boolean> =>
    new Promise((resolve, reject): void => {
      debug('is login disabled %o', isLoginEnabled);
      // FIXME: this logic does not work, review
      // const remoteUserAccess = !isLoginEnabled ? anonymousRemoteUser : remoteUser;
      try {
        auth.allow_access({ packageName: name }, remoteUser, (err, allowed): void => {
          if (err) {
            resolve(false);
          }
          resolve(allowed);
        });
      } catch (err: any) {
        reject(err);
      }
    });

  // Get list of all visible package
  route.get(
    '/packages',
    function (req: $RequestExtend, res: $ResponseExtend, next: $NextFunctionVer): void {
      debug('hit package web api %o');
      storage.getLocalDatabase(async function (err, packages): Promise<void> {
        if (err) {
          throw err;
        }
        async function processPackages(packages: PackageExt[] = []): Promise<PackageExt[]> {
          const permissions: PackageExt[] = [];
          const packagesToProcess = packages.slice();
          debug('process packages %o', packagesToProcess);
          for (const pkg of packagesToProcess) {
            const pkgCopy = { ...pkg };
            pkgCopy.author = formatAuthor(pkg.author);
            try {
              if (await checkAllow(pkg.name, req.remote_user)) {
                if (config.web) {
                  pkgCopy.author.avatar = generateGravatarUrl(
                    pkgCopy.author.email,
                    config.web.gravatar
                  );
                }
                // convert any remote dist to a local reference
                // eg: if the dist points to npmjs, switch to localhost:4873/prefix/etc.tar.gz
                if (!_.isNil(pkgCopy.dist) && !_.isNull(pkgCopy.dist.tarball)) {
                  pkgCopy.dist.tarball = getLocalRegistryTarballUri(
                    pkgCopy.dist.tarball,
                    pkg.name,
                    { protocol: req.protocol, headers: req.headers as any, host: req.hostname },
                    config?.url_prefix
                  );
                }
                permissions.push(pkgCopy);
              }
            } catch (err: any) {
              debug('process packages error %o', err);
              logger.logger.error(
                { name: pkg.name, error: err },
                'permission process for @{name} has failed: @{error}'
              );
              throw err;
            }
          }

          return permissions;
        }

        const order = getOrder(config?.web?.sort_packages);
        debug('order %o', order);

        try {
          next(sortByName(await processPackages(packages), order));
        } catch (error: any) {
          next(error);
        }
      });
    }
  );
}

export default addPackageWebApi;
