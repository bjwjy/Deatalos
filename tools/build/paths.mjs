import { fileURLToPath } from 'node:url';
import path from 'node:path';

export const root = fileURLToPath(new URL('../../', import.meta.url));
export const artifactRoot = path.join(root, 'artifacts/spike/F01');
export const cacheEnvironment = {
  ...process.env,
  npm_config_cache: path.join(root, 'artifacts/cache/npm'),
  ELECTRON_CACHE: path.join(root, 'artifacts/cache/electron'),
  electron_config_cache: path.join(root, 'artifacts/cache/electron'),
  ...(process.env.HTTPS_PROXY || process.env.HTTP_PROXY ? { ELECTRON_GET_USE_PROXY: '1' } : {}),
  ELECTRON_BUILDER_CACHE: path.join(root, 'artifacts/cache/electron-builder'),
  CSC_IDENTITY_AUTO_DISCOVERY: 'false',
};
