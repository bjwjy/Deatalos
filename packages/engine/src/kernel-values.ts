import type { NativePort } from './hopsan-map.js';
export const readKey = (ref: NativePort, variable: string) => `${ref.component}/${ref.port}/${variable}`;
